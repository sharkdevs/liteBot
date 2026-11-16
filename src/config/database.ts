import { PrismaPg } from '@prisma/adapter-pg';
import type { Logger } from 'pino';

import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

// node-postgres waits forever for a connection by default; fail the request instead.
const CONNECTION_TIMEOUT_MS = 5_000;

/** The Prisma API that repositories use: the full client, or one transaction's client. */
export type DatabaseClient = Prisma.TransactionClient;

// Prisma 7 connects through a driver adapter; the client opens connections lazily.
// https://www.prisma.io/docs/v7/prisma-orm/add-to-existing-project/postgresql#7-instantiate-prisma-client
export function createPrismaClient(databaseUrl: string, logger: Logger): PrismaClient {
  const adapter = new PrismaPg(
    { connectionString: databaseUrl, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS },
    {
      onPoolError: (err) => {
        logger.error({ err }, 'PostgreSQL idle connection error');
      },
      onConnectionError: (err) => {
        logger.error({ err }, 'PostgreSQL connection error');
      },
    },
  );
  return new PrismaClient({ adapter });
}
