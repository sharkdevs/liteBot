import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { pino } from 'pino';

import type { IAiProvider } from '../src/providers/ai/index.js';
import type { Message } from '../src/domain/message/message.js';
import type { IncomingMessageJob } from '../src/shared/types/incoming-message-job.js';
import type { IAiConversationService } from '../src/services/conversation.service.js';
import type { OutgoingMessageJob } from '../src/shared/types/outgoing-message-job.js';
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
    status: null,
    replyToMessageId: null,
    content: 'Previous user message',
    createdAt: new Date('2026-11-17T09:00:00Z'),
  },
  {
    id: 'previous-outbound',
    conversationId: job.conversationId,
    whatsappMessageId: null,
    direction: 'OUTBOUND',
    status: 'PENDING',
    replyToMessageId: null,
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
  const outgoing: OutgoingMessageJob[] = [];
  const conversationService: IAiConversationService = {
    findReplyToMessage: () => Promise.resolve(null),
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
        status: 'PENDING',
        replyToMessageId: null,
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

  await new AiResponseService(conversationService, provider, 'phi-4-mini', logger, {
    enqueue: (data) => {
      assert.equal(savedMessages.length, 1, 'Persist before queue publication');
      outgoing.push(data);
      return Promise.resolve();
    },
  }).process(job);

  assert.equal(receivedUserMessage, job.messageText);
  assert.deepEqual(receivedHistory, history);
  assert.deepEqual(savedMessages, [
    { conversationId: job.conversationId, content: 'Private generated response' },
  ]);
  assert.deepEqual(outgoing, [
    {
      phoneNumber: job.phoneNumber,
      conversationId: job.conversationId,
      messageId: 'outbound-message-id',
      content: 'Private generated response',
      correlationId: job.correlationId,
      userId: job.userId,
    },
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
  const conversationService: IAiConversationService = {
    findReplyToMessage: () => Promise.resolve(null),
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
  const service = new AiResponseService(conversationService, provider, 'phi-4-mini', pino(), {
    enqueue: () => Promise.reject(new Error('Unexpected enqueue')),
  });

  await assert.rejects(service.process(job), /Synthetic provider failure/);
  assert.equal(outboundSaveAttempted, false);
});

await test('publication failure retries the saved reply without another AI call or database row', async () => {
  let saved: Message | null = null;
  let generations = 0;
  let publications = 0;
  const conversationService: IAiConversationService = {
    recordInboundMessage: () => Promise.reject(new Error('Unexpected inbound write')),
    getRecentMessages: () => Promise.resolve([]),
    findReplyToMessage: () => Promise.resolve(saved),
    saveOutboundMessage: (conversationId, content, replyToMessageId) => {
      assert.equal(replyToMessageId, job.messageId);
      assert.equal(saved, null);
      saved = {
        id: 'stable-reply-id',
        conversationId,
        content,
        replyToMessageId: job.messageId,
        direction: 'OUTBOUND',
        status: 'PENDING',
        whatsappMessageId: null,
        createdAt: new Date(),
      };
      return Promise.resolve(saved);
    },
  };
  const service = new AiResponseService(
    conversationService,
    {
      generateResponse: () => {
        generations++;
        return Promise.resolve('Private reply');
      },
    },
    'synthetic-model',
    pino({ level: 'silent' }),
    {
      enqueue: (outgoing) => {
        publications++;
        assert.equal(outgoing.messageId, 'stable-reply-id');
        if (publications === 1) return Promise.reject(new Error('Redis unavailable'));
        return Promise.resolve();
      },
    },
  );
  await assert.rejects(service.process(job), /Redis unavailable/);
  await service.process(job);
  assert.equal(generations, 1);
  assert.equal(publications, 2);
});

await test('a failed outbound save prevents queue publication', async () => {
  const service = new AiResponseService(
    {
      recordInboundMessage: () => Promise.reject(new Error('Unexpected inbound write')),
      findReplyToMessage: () => Promise.resolve(null),
      getRecentMessages: () => Promise.resolve([]),
      saveOutboundMessage: () => Promise.reject(new Error('Database unavailable')),
    },
    { generateResponse: () => Promise.resolve('Private reply') },
    'synthetic-model',
    pino({ level: 'silent' }),
    {
      enqueue: () => {
        assert.fail('Unsaved replies must not be queued');
      },
    },
  );
  await assert.rejects(service.process(job), /Database unavailable/);
});

await test('incoming replays do not republish already finalized outbound replies', async () => {
  for (const status of ['SENT', 'FAILED'] as const) {
    const service = new AiResponseService(
      {
        recordInboundMessage: () => Promise.reject(new Error('Unexpected inbound write')),
        getRecentMessages: () => Promise.reject(new Error('Unexpected history load')),
        saveOutboundMessage: () => Promise.reject(new Error('Unexpected new reply')),
        findReplyToMessage: () =>
          Promise.resolve({
            id: 'existing-reply',
            conversationId: job.conversationId,
            content: 'Private reply',
            direction: 'OUTBOUND',
            status,
            replyToMessageId: job.messageId,
            whatsappMessageId: status === 'SENT' ? 'wamid.receipt' : null,
            createdAt: new Date(),
          }),
      },
      {
        generateResponse: () => Promise.reject(new Error('Unexpected generation')),
      },
      'synthetic-model',
      pino({ level: 'silent' }),
      {
        enqueue: () =>
          Promise.reject(new Error('Finalized replies must not be requeued automatically')),
      },
    );
    await service.process(job);
  }
});
