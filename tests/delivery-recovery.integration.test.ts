import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pino } from 'pino';

import { PrismaDeliveryRepository } from '../src/repositories/delivery.repository.js';
import { PrismaUnitOfWork } from '../src/repositories/unit-of-work.js';
import { ConversationService } from '../src/services/conversation.service.js';
import { OutgoingDispatchRelay } from '../src/services/outgoing-dispatch-relay.js';
import { WhatsAppDeliveryService } from '../src/services/whatsapp-delivery.service.js';
import { WhatsAppProviderError } from '../src/providers/whatsapp/whatsapp-provider.js';
import type { OutgoingMessageJob } from '../src/shared/types/outgoing-message-job.js';
import { createTestDatabase } from './support/test-database.js';
import { setupQueue } from './support/queue-fixture.js';

const database = await createTestDatabase();
const { prisma } = database;
const logger = pino({ level: 'silent' });
const service = new ConversationService(new PrismaUnitOfWork(prisma), logger);
const repository = new PrismaDeliveryRepository(prisma);
let sequence = 0;

async function reply(phone?: string): Promise<OutgoingMessageJob> {
  const index = ++sequence;
  const phoneNumber = phone ?? `1555${String(index).padStart(7, '0')}`;
  const saved = await service.recordInboundMessage({
    phoneNumber,
    correlationId: 'recovery-test',
    whatsappMessageId: `wamid.recovery-${String(index)}`,
    whatsappTimestamp: new Date(),
    content: 'Synthetic inbound',
  });
  const outbound = await service.saveOutboundMessage(
    saved.conversationId,
    'Synthetic outbound',
    saved.messageId,
    'recovery-test',
  );
  return {
    phoneNumber,
    messageId: outbound.id,
    conversationId: saved.conversationId,
    userId: saved.userId,
    content: outbound.content,
    correlationId: 'recovery-test',
  };
}

await test('durable outbound recovery', async (t) => {
  t.after(() => database.drop());

  await t.test(
    'a new relay recovers save-then-crash without replaying legacy replies',
    async () => {
      const job = await reply();
      const legacy = await service.saveOutboundMessage(job.conversationId, 'Legacy unsent reply');
      const broken = new OutgoingDispatchRelay(
        repository,
        {
          enqueue: () => Promise.reject(new Error('Redis unavailable')),
        },
        logger,
      );
      await assert.rejects(broken.runOnce(), /Redis unavailable/);
      const published: OutgoingMessageJob[] = [];
      // Nothing calls the AI service again: this is a fresh relay after the producer disappeared.
      const restarted = new OutgoingDispatchRelay(
        repository,
        {
          enqueue: (data) => {
            published.push(data);
            return Promise.resolve();
          },
        },
        logger,
      );
      await restarted.runOnce();
      assert.deepEqual(published, [job]);
      assert.ok(!published.some((data) => data.messageId === legacy.id));
      await repository.markSent(job.messageId, 'wamid.recovered');
    },
  );

  await t.test('replicas cannot claim the same message twice or redirect it', async () => {
    const job = await reply();
    await assert.rejects(repository.claim({ ...job, phoneNumber: '15559999999' }));
    const claims = await Promise.all([
      repository.claim(job),
      new PrismaDeliveryRepository(prisma).claim(job),
    ]);
    assert.deepEqual(claims.map((claim) => claim.state).sort(), ['claimed', 'unknown']);
    assert.equal((await repository.findById(job.messageId))?.status, 'UNKNOWN');
    const command = [
      '--import',
      'tsx',
      fileURLToPath(new URL('../src/reconcile-whatsapp.ts', import.meta.url)),
      job.messageId,
      'sent',
      'wamid.reconciled-acceptance',
    ];
    const options = {
      env: {
        ...process.env,
        DATABASE_URL: database.databaseUrl,
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '1',
      },
      timeout: 10_000,
    };
    await assert.rejects(promisify(execFile)(process.execPath, command, options));
    assert.equal((await repository.findById(job.messageId))?.status, 'UNKNOWN');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [...command, '--workers-stopped'],
      options,
    );
    assert.match(stdout, /WhatsApp acceptance reconciled/);
    assert.doesNotMatch(stdout, /Redis connection/);
    assert.equal((await repository.claim(job)).state, 'sent');
  });

  await t.test(
    'recipient order survives retries and pacing is shared across replicas',
    async () => {
      const first = await reply();
      const second = await reply(first.phoneNumber);
      await prisma.message.update({
        where: { id: first.messageId },
        data: { createdAt: new Date('2000-01-01') },
      });
      await prisma.message.update({
        where: { id: second.messageId },
        data: { createdAt: new Date('2001-01-01') },
      });
      assert.equal((await repository.claim(second)).state, 'deferred');
      assert.equal((await repository.claim(first)).state, 'claimed');
      assert.equal((await repository.claim(second)).state, 'deferred', 'UNKNOWN blocks overtaking');
      await repository.markPending(first.messageId);
      assert.equal(
        (await repository.claim(second)).state,
        'deferred',
        'Retrying an older reply preserves order',
      );
      const paced = await new PrismaDeliveryRepository(prisma).claim(first);
      assert.equal(paced.state, 'deferred');
      assert.ok(paced.until > new Date());
      await repository.markSent(first.messageId, 'wamid.ordered-first');
      assert.equal(
        (await repository.claim(second)).state,
        'deferred',
        'Even acceptance cannot bypass pacing',
      );
      // Advance only this test recipient's durable clock, rather than sleeping six seconds.
      await prisma.user.update({
        where: { id: first.userId },
        data: { nextWhatsappSendAt: new Date(0) },
      });
      assert.equal((await repository.claim(second)).state, 'claimed');
      await repository.markSent(second.messageId, 'wamid.ordered-second');
    },
  );

  await t.test(
    'lost acceptance stops retries until explicit operator recovery',
    { timeout: 15_000 },
    async (t) => {
      const fixture = await setupQueue(t);
      const job = await reply();
      let calls = 0;
      const worker = fixture.startWhatsAppWorker(
        new WhatsAppDeliveryService(
          repository,
          {
            sendTextMessage: () => {
              calls++;
              if (calls === 1) {
                return Promise.reject(
                  new WhatsAppProviderError(
                    'Receipt lost after acceptance',
                    true,
                    undefined,
                    undefined,
                    true,
                  ),
                );
              }
              return Promise.resolve({ providerResponseId: 'wamid.explicit-recovery' });
            },
          },
          fixture.logger,
        ),
      );
      const failed = once(worker, 'failed', { signal: AbortSignal.timeout(5000) });
      await fixture.outgoingQueue.enqueue(job);
      await failed;
      assert.equal((await repository.findById(job.messageId))?.status, 'UNKNOWN');
      const savedJob = await fixture.outgoingInspector.getJob(job.messageId);
      assert.ok(savedJob);
      const refusedReplay = once(worker, 'failed', { signal: AbortSignal.timeout(5000) });
      await savedJob.retry();
      await refusedReplay;
      assert.equal(calls, 1, 'A stalled/retried uncertain job must not issue another HTTP request');

      await fixture.outgoingQueue.removeFailedForReconciliation(job.messageId);
      await repository.reconcileUnknown(job.messageId, null);
      await prisma.user.update({
        where: { id: job.userId },
        data: { nextWhatsappSendAt: new Date(0) },
      });
      const completed = once(worker, 'completed', { signal: AbortSignal.timeout(5000) });
      await new OutgoingDispatchRelay(repository, fixture.outgoingQueue, fixture.logger).runOnce();
      await completed;
      assert.equal(
        calls,
        2,
        'Only the explicit not-accepted operator decision permits a new request',
      );
      assert.equal((await repository.findById(job.messageId))?.status, 'SENT');
      await assert.rejects(repository.reconcileUnknown(job.messageId, null));
    },
  );

  await t.test(
    'a blocked recipient is delayed without spending failed attempts',
    { timeout: 10_000 },
    async (t) => {
      const fixture = await setupQueue(t);
      const first = await reply();
      await prisma.message.update({
        where: { id: first.messageId },
        data: { createdAt: new Date('2000-01-01') },
      });
      const second = await reply(first.phoneNumber);
      assert.equal((await repository.claim(first)).state, 'claimed');
      let calls = 0;
      const worker = fixture.startWhatsAppWorker(
        new WhatsAppDeliveryService(
          repository,
          {
            sendTextMessage: () => {
              calls++;
              return Promise.resolve({ providerResponseId: 'wamid.after-deferral' });
            },
          },
          fixture.logger,
        ),
      );
      await fixture.outgoingQueue.enqueue(second);
      const queued = await fixture.outgoingInspector.getJob(second.messageId);
      assert.ok(queued);
      const timeout = AbortSignal.timeout(5000);
      while ((await queued.getState()) !== 'delayed') {
        await delay(10, undefined, { signal: timeout });
      }
      const deferred = await fixture.outgoingInspector.getJob(second.messageId);
      assert.ok(deferred);
      assert.equal(deferred.attemptsMade, 0);
      assert.equal(calls, 0);
      await repository.reconcileUnknown(first.messageId, 'wamid.older-confirmed');
      await prisma.user.update({
        where: { id: first.userId },
        data: { nextWhatsappSendAt: new Date(0) },
      });
      const completed = once(worker, 'completed', { signal: AbortSignal.timeout(5000) });
      await deferred.promote();
      await completed;
      assert.equal(calls, 1);
      assert.equal((await fixture.outgoingInspector.getJob(second.messageId))?.attemptsMade, 1);
      assert.equal((await repository.findById(second.messageId))?.status, 'SENT');
    },
  );
});
