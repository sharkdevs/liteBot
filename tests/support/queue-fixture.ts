import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Queue, RedisConnection } from 'bullmq';
import { pino } from 'pino';

import { createApp } from '../../src/app.js';
import { createRedisConnection } from '../../src/config/redis.js';
import { IncomingMessageQueue } from '../../src/queues/message.queue.js';
import { OutgoingMessageQueue } from '../../src/queues/outgoing-message.queue.js';
import {
  INCOMING_MESSAGE_QUEUE_NAME,
  OUTGOING_MESSAGE_QUEUE_NAME,
} from '../../src/queues/queue.constants.js';
import type { OutgoingMessageJob } from '../../src/shared/types/outgoing-message-job.js';
import type { IConversationService } from '../../src/services/conversation.service.js';
import type { IncomingMessageJob } from '../../src/shared/types/incoming-message-job.js';
import { createMessageWorker, type MessageProcessor } from '../../src/workers/message.worker.js';
import { createWhatsAppWorker } from '../../src/workers/whatsapp.worker.js';
import type { WhatsAppDeliveryService } from '../../src/services/whatsapp-delivery.service.js';

/** A queue under a unique Redis key prefix, removed after the test, plus captured logs. */
export async function setupQueue(t: TestContext) {
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
  const outgoingQueue = new OutgoingMessageQueue(connection, logger, { prefix });
  const outgoingInspector = new Queue<OutgoingMessageJob>(OUTGOING_MESSAGE_QUEUE_NAME, {
    connection: inspectionConnection,
    prefix,
  });
  const workers: Array<
    ReturnType<typeof createMessageWorker> | ReturnType<typeof createWhatsAppWorker>
  > = [];
  const workerConnections: ReturnType<typeof createRedisConnection>[] = [];
  t.after(async () => {
    try {
      await Promise.all(workers.map((worker) => worker.close()));
      await inspector.obliterate();
      await outgoingInspector.obliterate();
      await Promise.all([
        queue.close(),
        inspector.close(),
        outgoingQueue.close(),
        outgoingInspector.close(),
      ]);
    } finally {
      connection.disconnect();
      inspectionConnection.disconnect();
      workerConnections.forEach((client) => {
        client.disconnect();
      });
    }
  });
  await inspector.waitUntilReady();
  await outgoingInspector.waitUntilReady();
  return {
    queue,
    outgoingQueue,
    outgoingInspector,
    prefix,
    inspector,
    logger,
    logs,
    connection,
    settings,
    startWhatsAppWorker: (delivery: Pick<WhatsAppDeliveryService, 'send' | 'markFailed'>) => {
      const client = createRedisConnection(settings, logger, 'worker');
      workerConnections.push(client);
      const worker = createWhatsAppWorker(client, logger, delivery, { prefix });
      workers.push(worker);
      return worker;
    },
    startWorker: (processMessage: MessageProcessor = () => Promise.resolve()) => {
      const client = createRedisConnection(settings, logger, 'worker');
      workerConnections.push(client);
      const worker = createMessageWorker(client, logger, processMessage, { prefix });
      workers.push(worker);
      return worker;
    },
  };
}

export type QueueFixture = Awaited<ReturnType<typeof setupQueue>>;

/** Starts the HTTP app on a free port and returns the webhook URL. */
export async function startWebhook(
  t: TestContext,
  fixture: QueueFixture,
  conversationService: IConversationService,
) {
  const server = createApp({
    logger: fixture.logger,
    whatsappVerifyToken: 'integration-verification-token',
    conversationService,
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

/** A webhook body carrying one text message. */
export function textMessageWebhook(message: {
  phoneNumber: string;
  whatsappMessageId: string;
  messageText: string;
  timestamp: string;
}) {
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
                  id: message.whatsappMessageId,
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
