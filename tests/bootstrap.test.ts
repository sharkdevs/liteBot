import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
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
    conversationService: {
      recordInboundMessage: () => Promise.reject(new Error('Health requests must not save data')),
    },
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
          DATABASE_URL: 'postgresql://litebot:litebot@127.0.0.1:1/litebot',
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

await test(
  'a worker can shut down while Redis has never connected',
  { timeout: 8000 },
  async (t) => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await promisify(reservation.close.bind(reservation))();
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      process.once('message', () => {
        process.disconnect();
        process.emit('SIGTERM');
      });
      await import(${JSON.stringify(new URL('../src/worker.ts', import.meta.url).href)});
    `,
      ],
      {
        env: {
          ...process.env,
          LOG_LEVEL: 'info',
          PORT: 'not-used-by-worker',
          WHATSAPP_VERIFY_TOKEN: '',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: String(address.port),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) {
        child.kill();
      }
    });
    let output = '';
    const { stdout, stderr } = child;
    assert.ok(stdout && stderr);
    await new Promise<void>((resolve, reject) => {
      stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Redis connection error')) {
          resolve();
        }
      });
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', reject);
      child.once('exit', () => {
        reject(new Error(`Worker exited before its connection attempt: ${output}`));
      });
    });
    const exited = once(child, 'exit');
    child.send('shutdown');
    await exited;
    assert.equal(child.exitCode, 0, output);
    assert.match(output, /Shutting down/);
    assert.match(output, /closing worker without waiting for active jobs/);
    assert.doesNotMatch(output, /Graceful shutdown timed out/);
  },
);
