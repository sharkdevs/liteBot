import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';

import type { Message } from '../src/domain/message/message.js';
import { WhatsAppProviderError } from '../src/providers/whatsapp/whatsapp-provider.js';
import { WhatsAppDeliveryService } from '../src/services/whatsapp-delivery.service.js';
import type { OutgoingMessageJob } from '../src/shared/types/outgoing-message-job.js';

const job: OutgoingMessageJob = {
  phoneNumber: '15550000001',
  conversationId: 'conversation-id',
  messageId: 'outbound-id',
  content: 'Synthetic reply',
  correlationId: 'correlation-id',
  userId: 'user-id',
};

await test('acceptance followed by a lost response is never automatically sent again', async () => {
  let saved: Message = {
    id: job.messageId,
    conversationId: job.conversationId,
    direction: 'OUTBOUND',
    status: 'PENDING',
    content: job.content,
    createdAt: new Date(),
    whatsappMessageId: null,
    replyToMessageId: 'inbound-id',
  };
  let calls = 0;
  const service = new WhatsAppDeliveryService(
    {
      findById: () => Promise.resolve(saved),
      claim: () => {
        if (saved.status === 'UNKNOWN') return Promise.resolve({ state: 'unknown' as const });
        saved = { ...saved, status: 'UNKNOWN' };
        return Promise.resolve({ state: 'claimed' as const });
      },
      markPending: () => {
        assert.fail('An ambiguous result must not become eligible for automatic retry');
      },
      markSent: () => {
        assert.fail('A lost receipt must not be reported as SENT');
      },
      markFailed: () => {
        assert.fail('Unknown acceptance is not a confirmed failure');
      },
    },
    {
      sendTextMessage: () => {
        calls++;
        // The provider accepted the request, but the client never received its receipt.
        return Promise.reject(
          new WhatsAppProviderError('Response lost', true, undefined, undefined, true),
        );
      },
    },
    pino({ level: 'silent' }),
  );
  await assert.rejects(service.send(job));
  assert.equal(saved.status, 'UNKNOWN');
  await assert.rejects(service.send(job));
  assert.equal(calls, 1);
});
