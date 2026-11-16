import { loadWhatsAppWorkerEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/database.js';
import { createRedisConnection } from './config/redis.js';
import { WhatsAppCloudApiProvider } from './providers/whatsapp/whatsapp-cloud-api.provider.js';
import { MessageRepository } from './repositories/message.repository.js';
import { WhatsAppDeliveryService } from './services/whatsapp-delivery.service.js';
import { registerShutdown } from './shared/utils/shutdown.js';
import { createWhatsAppWorker } from './workers/whatsapp.worker.js';

const env = loadWhatsAppWorkerEnv();
const logger = createLogger(env.logLevel);
const prisma = createPrismaClient(env.databaseUrl, logger);
const connection = createRedisConnection(env.redis, logger, 'worker');
const delivery = new WhatsAppDeliveryService(
  new MessageRepository(prisma),
  new WhatsAppCloudApiProvider(env.whatsapp),
  logger,
);
const worker = createWhatsAppWorker(connection, logger, delivery);

registerShutdown(logger, async () => {
  try {
    if (connection.status === 'ready') {
      await worker.close();
    } else {
      logger.warn(
        { redisStatus: connection.status },
        'Redis is not ready; closing worker without waiting for active jobs',
      );
      await worker.close(true);
    }
  } finally {
    connection.disconnect();
    await prisma.$disconnect();
  }
});
