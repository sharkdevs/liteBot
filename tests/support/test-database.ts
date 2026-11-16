import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pino } from 'pino';

import { createPrismaClient } from '../../src/config/database.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

// The server and credentials only; each run creates (and later drops) its own database.
const DEFAULT_ADMIN_URL = 'postgresql://litebot:litebot@127.0.0.1:5432/litebot';
const PRISMA_CLI = fileURLToPath(
  new URL('../../node_modules/prisma/build/index.js', import.meta.url),
);

export interface TestDatabase {
  readonly prisma: PrismaClient;
  drop(): Promise<void>;
}

/** Creates an empty, fully migrated database so tests never touch development data. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const name = `litebot_test_${randomBytes(6).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const silent = pino({ level: 'silent' });
  const admin = createPrismaClient(adminUrl, silent);

  try {
    // `name` is generated above, never user input, so it is safe to interpolate.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.$disconnect();
    throw new Error('Persistence tests require a reachable PostgreSQL (see TEST_DATABASE_URL)', {
      cause: error,
    });
  }
  const dropDatabase = async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };

  try {
    await promisify(execFile)(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url.href },
    });
  } catch (error) {
    await dropDatabase().finally(() => admin.$disconnect());
    throw error;
  }

  const prisma = createPrismaClient(url.href, silent);
  return {
    prisma,
    async drop() {
      try {
        await prisma.$disconnect();
        await dropDatabase();
      } finally {
        await admin.$disconnect();
      }
    },
  };
}
