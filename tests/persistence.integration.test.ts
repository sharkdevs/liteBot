import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { pino } from 'pino';

import { ConversationRepository } from '../src/repositories/conversation.repository.js';
import { UserRepository } from '../src/repositories/user.repository.js';
import { PrismaUnitOfWork, type IUnitOfWork } from '../src/repositories/unit-of-work.js';
import {
  ConversationService,
  type InboundTextMessage,
} from '../src/services/conversation.service.js';
import { setupQueue, startWebhook, textMessageWebhook } from './support/queue-fixture.js';
import { createTestDatabase } from './support/test-database.js';

const database = await createTestDatabase();
const { prisma } = database;
const unitOfWork = new PrismaUnitOfWork(prisma);

let nextPhone = 0;
function syntheticPhoneNumber(): string {
  nextPhone += 1;
  return `1555${String(nextPhone).padStart(7, '0')}`;
}

function captureLogs() {
  const lines: string[] = [];
  const logger = pino(
    { level: 'debug' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
  return { logger, output: () => lines.join('') };
}

function inbound(phoneNumber: string, whatsappMessageId: string): InboundTextMessage {
  return {
    correlationId: 'persistence-test-correlation',
    phoneNumber,
    whatsappMessageId,
    content: 'PRIVATE_MESSAGE_TEXT',
  };
}

// One parent test, so the database is dropped once, after the last subtest.
await test('persistence layer', async (t) => {
  t.after(() => database.drop());

  await t.test(
    'a first message creates a user, a conversation, and an inbound message',
    async () => {
      const { logger, output } = captureLogs();
      const service = new ConversationService(unitOfWork, logger);
      const phoneNumber = syntheticPhoneNumber();

      const recorded = await service.recordInboundMessage(inbound(phoneNumber, 'wamid.first'));

      assert.equal(recorded.duplicate, false);
      const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber } });
      assert.equal(recorded.userId, user.id);
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { userId: user.id },
      });
      assert.equal(recorded.conversationId, conversation.id);
      const message = await prisma.message.findUniqueOrThrow({ where: { id: recorded.messageId } });
      assert.equal(message.conversationId, conversation.id);
      assert.equal(message.whatsappMessageId, 'wamid.first');
      assert.equal(message.direction, 'INBOUND');
      assert.equal(message.content, 'PRIVATE_MESSAGE_TEXT');

      const logs = output();
      assert.match(logs, new RegExp(`"userId":"${user.id}".*"msg":"User created"`));
      assert.match(
        logs,
        new RegExp(`"conversationId":"${conversation.id}".*"Conversation created"`),
      );
      assert.match(logs, new RegExp(`"messageId":"${message.id}".*"Inbound message saved"`));
      assert.doesNotMatch(logs, /PRIVATE_MESSAGE_TEXT/);
      assert.doesNotMatch(logs, new RegExp(phoneNumber));
    },
  );

  await t.test('a later message reuses the user and their latest conversation', async () => {
    const { logger, output } = captureLogs();
    const service = new ConversationService(unitOfWork, logger);
    const phoneNumber = syntheticPhoneNumber();

    const first = await service.recordInboundMessage(inbound(phoneNumber, 'wamid.later-1'));
    const second = await service.recordInboundMessage(inbound(phoneNumber, 'wamid.later-2'));

    assert.equal(second.userId, first.userId);
    assert.equal(second.conversationId, first.conversationId);
    assert.notEqual(second.messageId, first.messageId);
    assert.equal(await prisma.user.count({ where: { phoneNumber } }), 1);
    assert.equal(await prisma.conversation.count({ where: { userId: first.userId } }), 1);
    assert.equal(
      await prisma.message.count({ where: { conversationId: first.conversationId } }),
      2,
    );
    assert.match(output(), /Existing user found/);
    assert.match(output(), /Latest conversation found/);
  });

  await t.test('a redelivered message is saved once and returns the same IDs', async () => {
    const { logger, output } = captureLogs();
    const service = new ConversationService(unitOfWork, logger);
    const delivery = inbound(syntheticPhoneNumber(), 'wamid.redelivered');

    const original = await service.recordInboundMessage(delivery);
    const redelivery = await service.recordInboundMessage(delivery);

    assert.deepEqual(redelivery, { ...original, duplicate: true });
    assert.equal(
      await prisma.message.count({ where: { whatsappMessageId: 'wamid.redelivered' } }),
      1,
    );
    assert.match(output(), /Inbound message already saved/);
  });

  await t.test(
    'simultaneous first messages from one sender create one user and one conversation',
    async () => {
      const service = new ConversationService(unitOfWork, pino({ level: 'silent' }));
      const phoneNumber = syntheticPhoneNumber();

      const recorded = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          service.recordInboundMessage(inbound(phoneNumber, `wamid.concurrent-${String(n)}`)),
        ),
      );

      assert.equal(await prisma.user.count({ where: { phoneNumber } }), 1);
      const userId = recorded[0]?.userId ?? '';
      assert.equal(await prisma.conversation.count({ where: { userId } }), 1);
      assert.equal(await prisma.message.count({ where: { conversation: { userId } } }), 5);
    },
  );

  await t.test(
    'a failure while saving the message rolls back the user and conversation',
    async () => {
      const { logger, output } = captureLogs();
      const failingMessageSave: IUnitOfWork = {
        runExclusive: (lockKey, work) =>
          unitOfWork.runExclusive(lockKey, (repositories) =>
            work({
              ...repositories,
              messages: {
                findByWhatsappMessageId: (id) => repositories.messages.findByWhatsappMessageId(id),
                create: () => Promise.reject(new Error('Simulated database failure')),
              },
            }),
          ),
      };
      const service = new ConversationService(failingMessageSave, logger);
      const phoneNumber = syntheticPhoneNumber();

      await assert.rejects(
        service.recordInboundMessage(inbound(phoneNumber, 'wamid.rolled-back')),
        /Simulated database failure/,
      );

      assert.equal(await prisma.user.count({ where: { phoneNumber } }), 0);
      assert.equal(output(), '');
    },
  );

  await t.test('findLatestForUser returns the most recently created conversation', async () => {
    const users = new UserRepository(prisma);
    const conversations = new ConversationRepository(prisma);
    const user = await users.create({ phoneNumber: syntheticPhoneNumber() });
    assert.equal(await conversations.findLatestForUser(user.id), null);

    // Inserted newest first, so the result cannot depend on insertion order.
    const newer = await prisma.conversation.create({
      data: { userId: user.id, createdAt: new Date('2026-02-01T00:00:00Z') },
    });
    await prisma.conversation.create({
      data: { userId: user.id, createdAt: new Date('2026-01-01T00:00:00Z') },
    });

    assert.equal((await conversations.findLatestForUser(user.id))?.id, newer.id);
  });

  await t.test(
    'a webhook request saves the message, then a worker consumes its job',
    { timeout: 20_000 },
    async (t) => {
      const fixture = await setupQueue(t);
      const service = new ConversationService(unitOfWork, fixture.logger);
      const url = await startWebhook(t, fixture, service);
      const phoneNumber = syntheticPhoneNumber();
      const body = textMessageWebhook({
        phoneNumber,
        whatsappMessageId: 'wamid.end-to-end',
        messageText: 'PRIVATE_MESSAGE_TEXT',
        timestamp: '1794844800',
      });
      const post = () =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-correlation-id': 'e2e-correlation' },
          body,
        });

      const response = await post();

      assert.equal(response.status, 200);
      const user = await prisma.user.findUniqueOrThrow({
        where: { phoneNumber },
        include: { conversations: { include: { messages: true } } },
      });
      const conversation = user.conversations[0];
      const message = conversation?.messages[0];
      assert.equal(user.conversations.length, 1);
      assert.equal(conversation?.messages.length, 1);
      assert.ok(message);
      const [job] = await fixture.inspector.getWaiting();
      assert.equal(job?.id, message.id);
      assert.deepEqual(job.data, {
        correlationId: 'e2e-correlation',
        messageId: message.id,
        userId: user.id,
        conversationId: conversation.id,
        whatsappMessageId: 'wamid.end-to-end',
        phoneNumber,
        messageText: 'PRIVATE_MESSAGE_TEXT',
        timestamp: '1794844800',
      });

      const worker = fixture.startWorker();
      await once(worker, 'completed', { signal: AbortSignal.timeout(10_000) });
      const completion = fixture.logs.find((line) =>
        line.includes('Incoming message processing completed'),
      );
      assert.match(completion ?? '', new RegExp(`"messageId":"${message.id}"`));
      assert.match(completion ?? '', new RegExp(`"conversationId":"${conversation.id}"`));
      assert.match(completion ?? '', new RegExp(`"userId":"${user.id}"`));

      // Meta retries a delivery it thinks failed: nothing new is saved or queued.
      assert.equal((await post()).status, 200);
      assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 1);
      assert.equal(await fixture.inspector.getJobCountByTypes('waiting', 'active', 'completed'), 1);
      assert.doesNotMatch(fixture.logs.join(''), /PRIVATE_MESSAGE_TEXT/);
    },
  );
});
