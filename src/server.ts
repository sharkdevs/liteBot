import { promisify } from 'node:util';

import { createApp } from './app.js';
import { loadApiEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createRedisConnection } from './config/redis.js';
import { IncomingMessageQueue } from './queues/message.queue.js';
import { registerShutdown } from './shared/utils/shutdown.js';

const env = loadApiEnv();
const logger = createLogger(env.logLevel);
const connection = createRedisConnection(env.redis, logger, 'producer');
const incomingMessageQueue = new IncomingMessageQueue(connection, logger);
const app = createApp({
  logger,
  whatsappVerifyToken: env.whatsappVerifyToken,
  incomingMessageQueue,
});

const server = app.listen(env.port, (error) => {
  if (error) {
    logger.error({ err: error, port: env.port }, 'HTTP server failed to start');
    void shutdown('startup_failure', 1);
    return;
  }
  logger.info({ port: env.port }, 'HTTP server listening');
});

const shutdown = registerShutdown(logger, async () => {
  try {
    if (server.listening) {
      await promisify(server.close.bind(server))();
    }
    await incomingMessageQueue.close();
  } finally {
    connection.disconnect();
  }
});
