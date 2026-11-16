import { createNodeRedisClient, type IRedisClient } from 'bullmq';
import type { Logger } from 'pino';
import { createClient } from 'redis';

export interface RedisSettings {
  readonly host: string;
  readonly port: number;
}

export function createRedisConnection(
  settings: RedisSettings,
  logger: Logger,
  role: 'producer' | 'worker',
): IRedisClient {
  const rawClient = createClient({
    socket: { ...settings, connectTimeout: 2000 },
    disableOfflineQueue: role === 'producer',
    ...(role === 'producer' ? { commandOptions: { timeout: 2000 } } : {}),
  });
  const connection = createNodeRedisClient(rawClient);
  connection.on('error', (err: Error) => {
    logger.error({ err, role }, 'Redis connection error');
  });
  connection.on('ready', () => {
    logger.info({ role }, 'Redis connection ready');
  });
  connection.on('reconnecting', () => {
    logger.warn({ role }, 'Redis reconnecting');
  });
  return connection;
}
