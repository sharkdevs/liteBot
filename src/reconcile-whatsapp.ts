import { RedisConnection } from 'bullmq';
import { loadReconciliationEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/database.js';
import { createRedisConnection } from './config/redis.js';
import { PrismaDeliveryRepository } from './repositories/delivery.repository.js';
import { OutgoingMessageQueue } from './queues/outgoing-message.queue.js';

const env = loadReconciliationEnv();
const logger = createLogger(env.logLevel);
const [id, decision, ...rest] = process.argv.slice(2);
const validId = id !== undefined && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const receipt = decision === 'sent' ? rest[0] : null;
if (
  !validId ||
  !(
    (decision === 'sent' && typeof receipt === 'string' && receipt.trim() && rest.length === 2) ||
    (decision === 'not-sent' && rest.length === 1)
  ) ||
  rest.at(-1) !== '--workers-stopped'
) {
  logger.error(
    'Usage: reconcile-whatsapp <message UUID> sent <receipt> --workers-stopped OR <message UUID> not-sent --workers-stopped',
  );
  process.exitCode = 1;
} else {
  const prisma = createPrismaClient(env.databaseUrl, logger);
  let connection: ReturnType<typeof createRedisConnection> | undefined;
  let queue: OutgoingMessageQueue | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const repository = new PrismaDeliveryRepository(prisma);
    if (decision === 'not-sent') {
      connection = createRedisConnection(env.redis, logger, 'producer');
      queue = new OutgoingMessageQueue(connection, logger);
      await Promise.race([
        RedisConnection.waitUntilReady(connection),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            reject(new Error('Redis connection timed out'));
          }, 2000);
        }),
      ]);
      // Remove the failed job first: a crash here leaves UNKNOWN, never an unintended resend.
      await queue.removeFailedForReconciliation(id);
    }
    await repository.reconcileUnknown(id, receipt ?? null);
    logger.info({ messageId: id, decision }, 'WhatsApp acceptance reconciled');
  } catch {
    logger.error(
      { messageId: id },
      'Reconciliation failed; verify UNKNOWN state, stopped workers, and database/Redis availability',
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    try {
      await queue?.close();
    } finally {
      connection?.disconnect();
      await prisma.$disconnect();
    }
  }
}
