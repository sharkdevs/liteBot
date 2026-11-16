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
    await worker.close();
  } finally {
    connection.disconnect();
  }
});
