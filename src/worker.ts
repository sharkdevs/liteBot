import { loadWorkerEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createRedisConnection } from './config/redis.js';
import { registerShutdown } from './shared/utils/shutdown.js';
import { createMessageWorker } from './workers/message.worker.js';

const env = loadWorkerEnv();
const logger = createLogger(env.logLevel);
const connection = createRedisConnection(env.redis, logger, 'worker');
const worker = createMessageWorker(connection, logger);

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
    connection.disconnect();
  }
});
