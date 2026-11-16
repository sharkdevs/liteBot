import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { pino } from 'pino';

import type { Message } from '../src/domain/message/message.js';
import { WhatsAppDeliveryService } from '../src/services/whatsapp-delivery.service.js';
import { WhatsAppProviderError } from '../src/providers/whatsapp/whatsapp-provider.js';
import type { OutgoingMessageJob } from '../src/shared/types/outgoing-message-job.js';

const job: OutgoingMessageJob = {
  phoneNumber: '15550000001',
  conversationId: 'conversation-id',
  messageId: 'outbound-id',
  content: 'PRIVATE_REPLY',
  correlationId: 'correlation-id',
  userId: 'user-id',
};

function message(): Message {
  return {
    id: job.messageId,
    conversationId: job.conversationId,
    content: job.content,
    direction: 'OUTBOUND',
    status: 'PENDING',
    whatsappMessageId: null,
    replyToMessageId: 'inbound-id',
    createdAt: new Date(),
  };
}

await test('acceptance persists SENT before success logging, and repeated delivery skips HTTP', async () => {
  let saved = message();
  let calls = 0;
  const logs: string[] = [];
  const logger = pino(
    {},
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (chunk.toString().includes('WhatsApp message sent')) assert.equal(saved.status, 'SENT');
        logs.push(chunk.toString());
        callback();
      },
    }),
  );
  const service = new WhatsAppDeliveryService(
    {
      findById: () => Promise.resolve(saved),
      markSent: (_id, receipt) => {
        saved = { ...saved, status: 'SENT', whatsappMessageId: receipt };
        return Promise.resolve();
      },
      markFailed: () => Promise.reject(new Error('Unexpected failure')),
    },
    {
      sendTextMessage: (phone, text) => {
        calls++;
        assert.equal(phone, job.phoneNumber);
        assert.equal(text, job.content);
        return Promise.resolve({ providerResponseId: 'wamid.receipt' });
      },
    },
    logger,
  );
  await service.send(job);
  await service.send(job);
  assert.equal(calls, 1);
  assert.equal(saved.status, 'SENT');
  assert.match(logs.join(''), /"providerResponseId":"wamid.receipt"/);
  assert.match(logs.join(''), /"phoneNumber":"15550000001"/);
  assert.doesNotMatch(logs.join(''), /PRIVATE_REPLY/);
});

await test('transient transport failure does not mark SENT or FAILED before the worker decides', async () => {
  const saved = message();
  const service = new WhatsAppDeliveryService(
    {
      findById: () => Promise.resolve(saved),
      markSent: () => Promise.reject(new Error('Unexpected acceptance')),
      markFailed: () => Promise.reject(new Error('Unexpected terminal update')),
    },
    {
      sendTextMessage: () => Promise.reject(new WhatsAppProviderError('Temporary failure', true)),
    },
    pino({ level: 'silent' }),
  );
  await assert.rejects(service.send(job), /Temporary failure/);
  assert.equal(saved.status, 'PENDING');
});

await test('missing or inconsistent persisted outbound rows are never sent', async () => {
  for (const saved of [
    null,
    { ...message(), direction: 'INBOUND' as const },
    { ...message(), content: 'Other reply' },
  ]) {
    const service = new WhatsAppDeliveryService(
      {
        findById: () => Promise.resolve(saved),
        markSent: () => Promise.reject(new Error('Unexpected acceptance')),
        markFailed: () => Promise.reject(new Error('Unexpected terminal update')),
      },
      {
        sendTextMessage: () => {
          assert.fail('Invalid jobs must not send');
        },
      },
      pino({ level: 'silent' }),
    );
    await assert.rejects(service.send(job));
  }
});

await test('acceptance persistence failure records the receipt for investigation, not success', async () => {
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
  const service = new WhatsAppDeliveryService(
    {
      findById: () => Promise.resolve(message()),
      markSent: () => Promise.reject(new Error('PRIVATE_DATABASE_FAILURE')),
      markFailed: () => Promise.resolve(),
    },
    {
      sendTextMessage: () => Promise.resolve({ providerResponseId: 'wamid.unrecorded-receipt' }),
    },
    logger,
  );
  await assert.rejects(service.send(job), /acceptance could not be persisted/);
  assert.match(logs.join(''), /"providerResponseId":"wamid.unrecorded-receipt"/);
  assert.doesNotMatch(logs.join(''), /WhatsApp message sent|PRIVATE_DATABASE_FAILURE/);
});
