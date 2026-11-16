import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { pino } from 'pino';

import type { IAiProvider } from '../src/providers/ai/index.js';
import type { Message } from '../src/domain/message/message.js';
import type { IncomingMessageJob } from '../src/shared/types/incoming-message-job.js';
import type { IConversationService } from '../src/services/conversation.service.js';
import { AiResponseService } from '../src/services/ai-response.service.js';

const job: IncomingMessageJob = {
  correlationId: 'ai-response-correlation',
  messageId: 'inbound-message-id',
  userId: 'user-id',
  conversationId: 'conversation-id',
  whatsappMessageId: 'whatsapp-message-id',
  phoneNumber: '15550000001',
  messageText: 'Current user message',
  timestamp: '1794844800',
};

const history: Message[] = [
  {
    id: 'previous-inbound',
    conversationId: job.conversationId,
    whatsappMessageId: 'previous-whatsapp-message-id',
    direction: 'INBOUND',
    content: 'Previous user message',
    createdAt: new Date('2026-11-17T09:00:00Z'),
  },
  {
    id: 'previous-outbound',
    conversationId: job.conversationId,
    whatsappMessageId: null,
    direction: 'OUTBOUND',
    content: 'Previous assistant message',
    createdAt: new Date('2026-11-17T09:01:00Z'),
  },
];

await test('AI response is generated, persisted, and logged without logging its text', async () => {
  const logs: string[] = [];
  const logger = pino(
    { level: 'info' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    }),
  );
  const savedMessages: Array<{ conversationId: string; content: string }> = [];
  let receivedHistory: Message[] = [];
  let receivedUserMessage = '';
  const conversationService: IConversationService = {
    recordInboundMessage: () => Promise.reject(new Error('Unexpected inbound write')),
    getRecentMessages: (conversationId, limit, excludeMessageId) => {
      assert.equal(conversationId, job.conversationId);
      assert.equal(limit, 20);
      assert.equal(excludeMessageId, job.messageId);
      return Promise.resolve(history);
    },
    saveOutboundMessage: (conversationId, content) => {
      savedMessages.push({ conversationId, content });
      return Promise.resolve({
        id: 'outbound-message-id',
        conversationId,
        whatsappMessageId: null,
        direction: 'OUTBOUND',
        content,
        createdAt: new Date('2026-11-17T09:02:00Z'),
      });
    },
  };
  const provider: IAiProvider = {
    generateResponse: (userMessage, conversationHistory) => {
      const startLog = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
      assert.equal(startLog.msg, 'AI response generation started');
      assert.equal(startLog.correlationId, job.correlationId);
      assert.equal(startLog.messageId, job.messageId);
      assert.equal(startLog.modelName, 'phi-4-mini');
      receivedUserMessage = userMessage;
      receivedHistory = conversationHistory;
      return Promise.resolve('Private generated response');
    },
  };

  await new AiResponseService(conversationService, provider, 'phi-4-mini', logger).process(job);

  assert.equal(receivedUserMessage, job.messageText);
  assert.deepEqual(receivedHistory, history);
  assert.deepEqual(savedMessages, [
    { conversationId: job.conversationId, content: 'Private generated response' },
  ]);
  const log = JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(log.correlationId, job.correlationId);
  assert.equal(log.userId, job.userId);
  assert.equal(log.conversationId, job.conversationId);
  assert.equal(log.messageId, job.messageId);
  assert.equal(log.responseMessageId, 'outbound-message-id');
  assert.equal(log.modelName, 'phi-4-mini');
  assert.equal(log.responseLength, 'Private generated response'.length);
  assert.doesNotMatch(
    logs.join(''),
    /Private generated response|Current user message|Previous user message|Previous assistant message/,
  );
});

await test('AI provider failures propagate without persisting an outbound message', async () => {
  let outboundSaveAttempted = false;
  const conversationService: IConversationService = {
    recordInboundMessage: () => Promise.reject(new Error('Unexpected inbound write')),
    getRecentMessages: () => Promise.resolve(history),
    saveOutboundMessage: () => {
      outboundSaveAttempted = true;
      return Promise.reject(new Error('Unexpected outbound write'));
    },
  };
  const provider: IAiProvider = {
    generateResponse: () => Promise.reject(new Error('Synthetic provider failure')),
  };
  const service = new AiResponseService(conversationService, provider, 'phi-4-mini', pino());

  await assert.rejects(service.process(job), /Synthetic provider failure/);
  assert.equal(outboundSaveAttempted, false);
});
