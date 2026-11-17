import { loadWhatsAppWorkerEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/database.js';
import { createRedisConnection } from './config/redis.js';
import { WhatsAppCloudApiProvider } from './providers/whatsapp/whatsapp-cloud-api.provider.js';
import { PrismaDeliveryRepository } from './repositories/delivery.repository.js';
import { OutgoingMessageQueue } from './queues/outgoing-message.queue.js';
import { OutgoingDispatchRelay } from './services/outgoing-dispatch-relay.js';
import { WhatsAppDeliveryService } from './services/whatsapp-delivery.service.js';
import { registerShutdown } from './shared/utils/shutdown.js';
import { createWhatsAppWorker } from './workers/whatsapp.worker.js';

const env = loadWhatsAppWorkerEnv();
const logger = createLogger(env.logLevel);
const prisma = createPrismaClient(env.databaseUrl, logger);
const connection = createRedisConnection(env.redis, logger, 'worker');
const producerConnection = createRedisConnection(env.redis, logger, 'producer');
const outgoingQueue = new OutgoingMessageQueue(producerConnection, logger);
const repository = new PrismaDeliveryRepository(prisma);
const delivery = new WhatsAppDeliveryService(
  repository,
  new WhatsAppCloudApiProvider(env.whatsapp),
  logger,
);
const worker = createWhatsAppWorker(connection, logger, delivery);
let stopping = false;
let stopRelay: () => Promise<void> = () => Promise.resolve();
producerConnection.once('ready', () => {
  if (!stopping) stopRelay = new OutgoingDispatchRelay(repository, outgoingQueue, logger).start();
});

registerShutdown(logger, async () => {
  try {
    stopping = true;
    await stopRelay();
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
    try {
      await outgoingQueue.close();
    } finally {
      connection.disconnect();
      producerConnection.disconnect();
      await prisma.$disconnect();
    }
  }
});
