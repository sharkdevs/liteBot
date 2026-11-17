import { loadWorkerEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/database.js';
import { createRedisConnection } from './config/redis.js';
import { PromptBuilder } from './prompts/prompt-builder.js';
import { createAiProvider } from './providers/ai/index.js';
import { OutgoingMessageQueue } from './queues/outgoing-message.queue.js';
import { PrismaUnitOfWork } from './repositories/unit-of-work.js';
import { AiResponseService } from './services/ai-response.service.js';
import { ConversationService } from './services/conversation.service.js';
import { registerShutdown } from './shared/utils/shutdown.js';
import { createMessageWorker } from './workers/message.worker.js';

const env = loadWorkerEnv();
const logger = createLogger(env.logLevel);
const prisma = createPrismaClient(env.databaseUrl, logger);
const connection = createRedisConnection(env.redis, logger, 'worker');
const producerConnection = createRedisConnection(env.redis, logger, 'producer');
const outgoingQueue = new OutgoingMessageQueue(producerConnection, logger);
const conversationService = new ConversationService(new PrismaUnitOfWork(prisma), logger);
const { provider, modelName } = createAiProvider(env.ai, new PromptBuilder());
const aiResponseService = new AiResponseService(
  conversationService,
  provider,
  modelName,
  logger,
  outgoingQueue,
);
const worker = createMessageWorker(connection, logger, (job) => aiResponseService.process(job));

registerShutdown(logger, async () => {
  try {
    if (connection.status === 'ready') {
      await worker.close();
    } else {
      // A graceful close waits for Redis indefinitely. An interrupted job's
      // lock expires, so BullMQ's stalled-job check can return it to the queue.
      logger.warn(
        { redisStatus: connection.status },
        'Redis is not ready; closing worker without waiting for active jobs',
      );
      await worker.close(true);
    }
  } finally {
    try {
      await outgoingQueue.close();
    } finally {
      connection.disconnect();
      producerConnection.disconnect();
      await prisma.$disconnect();
    }
  }
});
