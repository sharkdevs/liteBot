import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createClient } from 'redis';
import { WhatsAppProviderError } from '../src/providers/whatsapp/whatsapp-provider.js';

import type { IConversationService } from '../src/services/conversation.service.js';
import type { IncomingMessageJob } from '../src/shared/types/incoming-message-job.js';
import { setupQueue, startWebhook, textMessageWebhook } from './support/queue-fixture.js';

// IDs that a real database would have assigned; this file tests Redis, not PostgreSQL.
const message: IncomingMessageJob = {
  correlationId: 'queue-test-correlation',
  messageId: 'message-queue-test',
  userId: 'user-queue-test',
  conversationId: 'conversation-queue-test',
  whatsappMessageId: 'wamid.queue-test',
  phoneNumber: '15550000001',
  messageText: 'PRIVATE_MESSAGE_TEXT',
  timestamp: '1794844800',
};

const savedMessage: IConversationService = {
  recordInboundMessage: () =>
    Promise.resolve({
      userId: message.userId,
      conversationId: message.conversationId,
      messageId: message.messageId,
      duplicate: false,
    }),
  getRecentMessages: () => Promise.resolve([]),
  saveOutboundMessage: () => Promise.reject(new Error('Queue tests must not save replies')),
};

function webhookBody() {
  return textMessageWebhook(message);
}

await test(
  'HTTP acknowledges Redis acceptance before a worker consumes the message',
  { timeout: 15_000 },
  async (t) => {
    const fixture = await setupQueue(t);
    const url = await startWebhook(t, fixture, savedMessage);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': message.correlationId },
      body: webhookBody(),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
    const waiting = await fixture.inspector.getWaiting();
    assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0]?.data, message);
    assert.equal(await fixture.inspector.getCompletedCount(), 0);

    const worker = fixture.startWorker();
    await once(worker, 'completed', { signal: AbortSignal.timeout(10_000) });
    assert.equal(await fixture.inspector.getCompletedCount(), 1);
    const output = fixture.logs.join('');
    assert.match(output, /WhatsApp webhook payload received/);
    assert.match(output, /Incoming message queued/);
    assert.match(output, /Incoming message processing completed/);
    assert.match(output, /"correlationId":"queue-test-correlation"/);
    assert.doesNotMatch(output, /PRIVATE_MESSAGE_TEXT/);
  },
);

await test(
  'a disconnected producer returns 500 without acknowledging a job',
  { timeout: 15_000 },
  async (t) => {
    const fixture = await setupQueue(t);
    const url = await startWebhook(t, fixture, savedMessage);
    fixture.connection.disconnect();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: webhookBody(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal server error' });
    assert.equal(await fixture.inspector.getWaitingCount(), 0);
    assert.doesNotMatch(fixture.logs.join(''), /Incoming message queued/);
  },
);

await test(
  'the producer keeps accepting messages after Redis loses its Lua scripts',
  { timeout: 15_000 },
  async (t) => {
    const { queue, inspector, settings } = await setupQueue(t);
    await queue.enqueue([message]);
    // A Redis restart empties its script cache; SCRIPT FLUSH does the same without deleting data.
    const admin = createClient({ socket: settings });
    await admin.connect();
    try {
      await admin.scriptFlush();
    } finally {
      admin.destroy();
    }

    await queue.enqueue([{ ...message, messageId: 'message-after-script-flush' }]);
    assert.equal(await inspector.getWaitingCount(), 2);
  },
);

await test(
  'enqueueing the same saved message twice keeps one job',
  { timeout: 15_000 },
  async (t) => {
    const { queue, inspector } = await setupQueue(t);
    await queue.enqueue([message]);
    await queue.enqueue([message]);
    const waiting = await inspector.getWaiting();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.id, message.messageId);
  },
);

await test(
  'a message waits in Redis until a worker logs completion',
  { timeout: 15_000 },
  async (t) => {
    const { queue, inspector, logs, startWorker } = await setupQueue(t);
    await queue.enqueue([message]);
    const waiting = await inspector.getWaiting();
    assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0]?.data, message);

    const worker = startWorker();
    await once(worker, 'completed', { signal: AbortSignal.timeout(10_000) });
    assert.equal(await inspector.getCompletedCount(), 1);
    const output = logs.join('');
    assert.match(output, /Incoming message queued/);
    assert.match(output, /Incoming message processing started/);
    assert.match(output, /Incoming message payload received/);
    assert.match(output, /Incoming message processing completed/);
    assert.match(output, /"correlationId":"queue-test-correlation"/);
    assert.match(output, /"jobId":"message-queue-test"/);
    assert.match(output, /"userId":"user-queue-test","conversationId":"conversation-queue-test"/);
    assert.match(output, /"messageId":"message-queue-test","whatsappMessageId":"wamid.queue-test"/);
    assert.doesNotMatch(output, /PRIVATE_MESSAGE_TEXT/);
  },
);

await test(
  'failed processing retries twice with backoff and can complete',
  { timeout: 15_000 },
  async (t) => {
    const { queue, inspector, logger, logs, startWorker } = await setupQueue(t);
    const originalInfo = logger.info.bind(logger);
    const attempts: number[] = [];
    t.mock.method(logger, 'info', (fields: unknown, description?: string) => {
      if (description === 'Incoming message payload received') {
        attempts.push(performance.now());
        if (attempts.length < 3) {
          throw new Error('Simulated transient processing failure');
        }
      }
      originalInfo(fields, description);
    });
    const worker = startWorker();
    const completed = once(worker, 'completed', { signal: AbortSignal.timeout(10_000) });
    await queue.enqueue([message]);
    await completed;

    assert.equal(attempts.length, 3);
    assert.ok((attempts[1] ?? 0) - (attempts[0] ?? 0) >= 900);
    assert.ok((attempts[2] ?? 0) - (attempts[1] ?? 0) >= 1900);
    assert.equal(await inspector.getCompletedCount(), 1);
    const output = logs.join('');
    assert.equal(output.match(/Incoming message job failed/g)?.length, 2);
    assert.equal(output.match(/Retrying incoming message/g)?.length, 2);
    assert.match(output, /"attempt":3/);
    assert.match(output, /Incoming message processing completed/);
  },
);

await test(
  'three unsuccessful attempts leave a failed job without completion',
  { timeout: 15_000 },
  async (t) => {
    const { queue, inspector, logger, logs, startWorker } = await setupQueue(t);
    const originalInfo = logger.info.bind(logger);
    t.mock.method(logger, 'info', (fields: unknown, description?: string) => {
      if (description === 'Incoming message payload received') {
        throw new Error('Simulated permanent processing failure');
      }
      originalInfo(fields, description);
    });
    const worker = startWorker();
    const exhausted = new Promise<void>((resolve) => {
      worker.on('failed', (job) => {
        if (job?.attemptsMade === 3) {
          resolve();
        }
      });
    });
    await queue.enqueue([message]);
    await exhausted;

    assert.equal(await inspector.getFailedCount(), 1);
    assert.equal(await inspector.getCompletedCount(), 0);
    const output = logs.join('');
    assert.equal(output.match(/Incoming message job failed/g)?.length, 3);
    assert.equal(output.match(/Retrying incoming message/g)?.length, 2);
    assert.doesNotMatch(output, /Incoming message processing completed/);
  },
);
await test('outgoing publication deduplicates the saved reply ID and fails promptly offline', async (t) => {
  const { outgoingQueue, outgoingInspector, connection, logs } = await setupQueue(t);
  const outgoing = {
    phoneNumber: '15550000001',
    conversationId: 'conversation-outgoing',
    messageId: 'message-outgoing',
    content: 'PRIVATE_OUTBOUND_CONTENT',
    correlationId: 'outgoing-correlation',
    userId: 'user-outgoing',
  };
  await outgoingQueue.enqueue(outgoing);
  await outgoingQueue.enqueue(outgoing);
  assert.equal(await outgoingInspector.getWaitingCount(), 1);
  const saved = await outgoingInspector.getJob(outgoing.messageId);
  assert.equal(saved?.opts.attempts, 3);
  assert.deepEqual(saved.opts.backoff, { type: 'exponential', delay: 1000 });
  assert.doesNotMatch(logs.join(''), /PRIVATE_OUTBOUND_CONTENT/);
  connection.disconnect();
  await assert.rejects(outgoingQueue.enqueue({ ...outgoing, messageId: 'offline' }), /not ready/);
});

await test(
  'terminal status write failures are awaited, surfaced, and never reported as success',
  { timeout: 10_000 },
  async (t) => {
    const { outgoingQueue, outgoingInspector, logs, startWhatsAppWorker } = await setupQueue(t);
    let statusWrites = 0;
    const worker = startWhatsAppWorker({
      send: () =>
        Promise.reject(new WhatsAppProviderError('PRIVATE_PROVIDER_FAILURE', false, 401, 190)),
      markFailed: () => {
        statusWrites++;
        return Promise.reject(new Error('PRIVATE_DATABASE_FAILURE'));
      },
    });
    const failed = once(worker, 'failed', { signal: AbortSignal.timeout(5000) });
    await outgoingQueue.enqueue({
      phoneNumber: message.phoneNumber,
      conversationId: message.conversationId,
      messageId: 'failure-state-write',
      content: 'PRIVATE_CONTENT',
      correlationId: message.correlationId,
      userId: message.userId,
    });
    await failed;
    assert.equal(statusWrites, 1);
    const saved = await outgoingInspector.getJob('failure-state-write');
    assert.ok(saved);
    assert.equal(await saved.getState(), 'failed');
    assert.equal(saved.failedReason, 'Outgoing message failure status persistence failed');
    assert.match(logs.join(''), /FAILED status could not be persisted/);
    assert.doesNotMatch(logs.join(''), /processing completed|PRIVATE_/);
  },
);
