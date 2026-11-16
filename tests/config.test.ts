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
