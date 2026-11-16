import type { Logger } from 'pino';

export function registerShutdown(logger: Logger, close: () => Promise<void>) {
  let stopping = false;
  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    process.exitCode = exitCode;
    logger.info({ reason }, 'Shutting down');
    const deadline = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    try {
      await close();
      clearTimeout(deadline);
    } catch (err) {
      logger.error({ err }, 'Graceful shutdown failed');
      process.exitCode = 1;
    }
  }
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  return shutdown;
}
