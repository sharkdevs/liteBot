import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

const server = createApp().listen(env.port, (error) => {
  if (error) {
    logger.error({ err: error, port: env.port }, 'HTTP server failed to start');
    process.exitCode = 1;
    return;
  }
  logger.info({ port: env.port }, 'HTTP server listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'Error while closing HTTP server');
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
