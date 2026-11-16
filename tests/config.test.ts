import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadApiEnv, loadWorkerEnv } from '../src/config/env.js';

for (const redis of [
  { REDIS_HOST: '' },
  { REDIS_PORT: '' },
  { REDIS_PORT: 'not-a-port' },
  { REDIS_PORT: '0' },
  { REDIS_PORT: '65536' },
]) {
  await test(`Redis configuration rejects ${JSON.stringify(redis)}`, () => {
    assert.throws(
      () => loadApiEnv({ WHATSAPP_VERIFY_TOKEN: 'synthetic-token', ...redis }),
      /REDIS_HOST|REDIS_PORT/,
    );
    assert.throws(() => loadWorkerEnv(redis), /REDIS_HOST|REDIS_PORT/);
  });
}

await test('worker configuration does not require the API token or HTTP port', () => {
  const worker = loadWorkerEnv({
    WHATSAPP_VERIFY_TOKEN: '',
    PORT: 'not-an-http-port',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6380',
  });
  assert.deepEqual(worker.redis, { host: '127.0.0.1', port: 6380 });
  assert.throws(() => loadApiEnv({ WHATSAPP_VERIFY_TOKEN: '' }), /WHATSAPP_VERIFY_TOKEN/);
});

const apiSettings = { WHATSAPP_VERIFY_TOKEN: 'synthetic-token' };

for (const databaseUrl of [
  undefined,
  '',
  '   ',
  'not a url',
  'mysql://litebot:PRIVATE_DB_PASSWORD@localhost:3306/litebot',
]) {
  await test(`API configuration rejects DATABASE_URL ${JSON.stringify(databaseUrl)}`, () => {
    const source =
      databaseUrl === undefined ? apiSettings : { ...apiSettings, DATABASE_URL: databaseUrl };
    assert.throws(
      () => loadApiEnv(source),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /DATABASE_URL must be a postgresql:\/\/ connection string/);
        assert.doesNotMatch(error.message, /PRIVATE_DB_PASSWORD/);
        return true;
      },
    );
  });
}

await test('API configuration accepts a PostgreSQL DATABASE_URL; the worker does not need one', () => {
  for (const databaseUrl of [
    'postgresql://user:password@localhost:5432/litebot?schema=public',
    'postgres://user:password@db.internal/litebot',
  ]) {
    assert.equal(
      loadApiEnv({ ...apiSettings, DATABASE_URL: databaseUrl }).databaseUrl,
      databaseUrl,
    );
  }
  assert.ok(!('databaseUrl' in loadWorkerEnv({})));
});
