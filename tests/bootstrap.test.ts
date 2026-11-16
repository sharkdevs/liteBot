import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/config/logger.js';

const execFileAsync = promisify(execFile);

await test('startup rejects an unconfigured webhook verification token', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))],
      {
        env: { ...process.env, PORT: '3000', LOG_LEVEL: 'info', WHATSAPP_VERIFY_TOKEN: '' },
        timeout: 10_000,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'stderr' in error);
      assert.equal(error.code, 1);
      assert.ok(typeof error.stderr === 'string');
      assert.match(error.stderr, /WHATSAPP_VERIFY_TOKEN must be configured/);
      return true;
    },
  );
});

await test('health returns the Stage 1 response without database or Redis connections', async (t) => {
  const server = createApp({
    logger: createLogger('silent'),
    whatsappVerifyToken: 'test-verification-token',
    incomingMessageQueue: {
      enqueue: () => Promise.reject(new Error('Health requests must not enqueue jobs')),
    },
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    await promisify(server.close.bind(server))();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const response = await fetch(`http://127.0.0.1:${String(address.port)}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'healthy' });
});

await test('an occupied port produces an error and a nonzero exit, not a success log', async (t) => {
  const occupied = createServer();
  t.after(async () => {
    await promisify(occupied.close.bind(occupied))();
  });
  occupied.listen(0);
  await once(occupied, 'listening');
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          PORT: String(address.port),
          LOG_LEVEL: 'info',
          WHATSAPP_VERIFY_TOKEN: 'test-verification-token',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: '1',
        },
        timeout: 10_000,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'stdout' in error);
      assert.equal(error.code, 1);
      assert.ok(typeof error.stdout === 'string');
      assert.match(error.stdout, /EADDRINUSE/);
      assert.doesNotMatch(error.stdout, /HTTP server listening/);
      return true;
    },
  );
});
