import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Queue, RedisConnection } from 'bullmq';
import { pino } from 'pino';

import { createApp } from '../src/app.js';
import { createRedisConnection } from '../src/config/redis.js';
import { IncomingMessageQueue } from '../src/queues/message.queue.js';
import { INCOMING_MESSAGE_QUEUE_NAME } from '../src/queues/queue.constants.js';
import type { IncomingMessageJob } from '../src/shared/types/incoming-message-job.js';
import { createMessageWorker } from '../src/workers/message.worker.js';

async function setupQueue(t: TestContext) {
  const prefix = `litebot-test-${randomUUID()}`;
  const logs: string[] = [];
  const logger = pino(
    {},
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    }),
  );
  const settings = { host: '127.0.0.1', port: Number(process.env.TEST_REDIS_PORT ?? '6379') };
  const connection = createRedisConnection(settings, logger, 'producer');
  let readyTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      RedisConnection.waitUntilReady(connection),
      new Promise<never>((_resolve, reject) => {
        readyTimeout = setTimeout(() => {
          reject(new Error('Redis integration tests require a reachable local Redis server'));
        }, 5000);
      }),
    ]);
  } catch (error) {
    connection.disconnect();
    throw error;
  } finally {
    clearTimeout(readyTimeout);
  }
  const inspectionConnection = createRedisConnection(settings, logger, 'producer');
  const queue = new IncomingMessageQueue(connection, logger, { prefix });
  const inspector = new Queue<IncomingMessageJob>(INCOMING_MESSAGE_QUEUE_NAME, {
    connection: inspectionConnection,
    prefix,
  });
  const workers: ReturnType<typeof createMessageWorker>[] = [];
  const workerConnections: ReturnType<typeof createRedisConnection>[] = [];
  t.after(async () => {
    try {
      await Promise.all(workers.map((worker) => worker.close()));
      await inspector.obliterate();
      await Promise.all([queue.close(), inspector.close()]);
    } finally {
      connection.disconnect();
      inspectionConnection.disconnect();
      workerConnections.forEach((client) => {
        client.disconnect();
      });
    }
  });
  await inspector.waitUntilReady();
  return {
    queue,
    inspector,
    logger,
    logs,
    connection,
    startWorker: () => {
      const client = createRedisConnection(settings, logger, 'worker');
      workerConnections.push(client);
      const worker = createMessageWorker(client, logger, { prefix });
      workers.push(worker);
      return worker;
    },
  };
}

async function startWebhook(t: TestContext, fixture: Awaited<ReturnType<typeof setupQueue>>) {
  const server = createApp({
    logger: fixture.logger,
    whatsappVerifyToken: 'integration-verification-token',
    incomingMessageQueue: fixture.queue,
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    await promisify(server.close.bind(server))();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${String(address.port)}/webhook`;
}

const message: IncomingMessageJob = {
  phoneNumber: '15550000001',
  messageId: 'wamid.queue-test',
  messageText: 'PRIVATE_MESSAGE_TEXT',
  timestamp: '1794844800',
  correlationId: 'queue-test-correlation',
};

function webhookBody() {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'synthetic-business',
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  id: message.messageId,
                  from: message.phoneNumber,
                  type: 'text',
                  text: { body: message.messageText },
                  timestamp: message.timestamp,
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

await test(
  'HTTP acknowledges Redis acceptance before a worker consumes the message',
  { timeout: 15_000 },
  async (t) => {
    const fixture = await setupQueue(t);
    const url = await startWebhook(t, fixture);
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
    const url = await startWebhook(t, fixture);
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
    assert.match(output, /"messageId":"wamid.queue-test"/);
    assert.match(output, /"jobId":"\d+"/);
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
