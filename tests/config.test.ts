import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadApiEnv, loadReconciliationEnv, loadWorkerEnv } from '../src/config/env.js';

for (const redis of [
  { REDIS_HOST: '' },
  { REDIS_PORT: '' },
  { REDIS_PORT: 'not-a-port' },
  { REDIS_PORT: '0' },
  { REDIS_PORT: '65536' },
]) {
  await test(`Redis configuration rejects ${JSON.stringify(redis)}`, () => {
    assert.throws(
      () =>
        loadApiEnv({
          WHATSAPP_VERIFY_TOKEN: 'synthetic-token',
          WHATSAPP_APP_SECRET: 'synthetic-app-secret',
          ...redis,
        }),
      /REDIS_HOST|REDIS_PORT/,
    );
    assert.throws(() => loadWorkerEnv(redis), /REDIS_HOST|REDIS_PORT/);
    assert.throws(() => loadReconciliationEnv(redis), /REDIS_HOST|REDIS_PORT/);
  });
}

await test('worker configuration does not require the API token, app secret or HTTP port', () => {
  const worker = loadWorkerEnv({
    WHATSAPP_VERIFY_TOKEN: '',
    WHATSAPP_APP_SECRET: '',
    PORT: 'not-an-http-port',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6380',
    DATABASE_URL: 'postgresql://db.internal/litebot',
    AZURE_AI_FOUNDRY_ENDPOINT: 'https://foundry.example.com/openai/v1/',
    AZURE_AI_FOUNDRY_API_KEY: 'synthetic-key',
  });
  assert.deepEqual(worker.redis, { host: '127.0.0.1', port: 6380 });
  assert.equal(worker.databaseUrl, 'postgresql://db.internal/litebot');
  assert.equal(worker.ai.provider, 'azure-foundry');
  assert.equal(worker.ai.endpoint, 'https://foundry.example.com/openai/v1/');
  assert.equal(worker.ai.apiKey, 'synthetic-key');
  assert.equal(worker.ai.modelName, 'phi-4-mini');
  assert.throws(() => loadApiEnv({ WHATSAPP_VERIFY_TOKEN: '' }), /WHATSAPP_VERIFY_TOKEN/);
});

const apiSettings = {
  WHATSAPP_VERIFY_TOKEN: 'synthetic-token',
  WHATSAPP_APP_SECRET: 'synthetic-app-secret',
};

for (const appSecret of [undefined, '', ' \t ']) {
  await test(`API configuration rejects an absent or blank app secret: ${JSON.stringify(appSecret)}`, () => {
    assert.throws(
      () =>
        loadApiEnv({
          ...apiSettings,
          WHATSAPP_APP_SECRET: appSecret,
          DATABASE_URL: 'postgresql://db.internal/litebot',
        }),
      /WHATSAPP_APP_SECRET must be configured with a non-empty value/,
    );
  });
}

await test('API configuration preserves app secret bytes for signature verification', () => {
  const appSecret = ' synthetic-app-secret ';
  const env = loadApiEnv({
    ...apiSettings,
    WHATSAPP_APP_SECRET: appSecret,
    DATABASE_URL: 'postgresql://db.internal/litebot',
  });
  assert.equal(env.whatsappAppSecret, appSecret);
});

await test('reconciliation configuration only needs database, Redis and log settings', () => {
  const env = loadReconciliationEnv({
    DATABASE_URL: 'postgresql://127.0.0.1:1/litebot',
    LOG_LEVEL: 'warn',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6380',
    PORT: 'not-an-http-port',
    WHATSAPP_VERIFY_TOKEN: '',
    WHATSAPP_APP_SECRET: '',
    WHATSAPP_ACCESS_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
    AI_PROVIDER: 'unsupported-provider',
    AZURE_AI_FOUNDRY_ENDPOINT: '',
    AZURE_AI_FOUNDRY_API_KEY: '',
  });
  assert.deepEqual(env, {
    databaseUrl: 'postgresql://127.0.0.1:1/litebot',
    logLevel: 'warn',
    redis: { host: '127.0.0.1', port: 6380 },
  });
  assert.throws(() => loadReconciliationEnv({}), /DATABASE_URL/);
  assert.throws(
    () =>
      loadReconciliationEnv({
        DATABASE_URL: 'postgresql://127.0.0.1:1/litebot',
        LOG_LEVEL: 'not-a-log-level',
      }),
    /LOG_LEVEL/,
  );
});

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
  assert.equal(
    loadWorkerEnv({
      DATABASE_URL: 'postgresql://db.internal/litebot',
      AZURE_AI_FOUNDRY_ENDPOINT: 'https://foundry.example.com/openai/v1/',
      AZURE_AI_FOUNDRY_API_KEY: 'synthetic-key',
    }).databaseUrl,
    'postgresql://db.internal/litebot',
  );
});

await test('API configuration does not require, validate, or expose Azure AI Foundry settings', () => {
  const api = loadApiEnv({
    ...apiSettings,
    DATABASE_URL: 'postgresql://db.internal/litebot',
    AI_PROVIDER: 'unsupported-provider',
    AZURE_AI_FOUNDRY_ENDPOINT: 'http://foundry.example.com',
  });
  assert.ok(!('ai' in api));
  assert.ok(!('aiProvider' in api));
});

await test('worker configuration requires a PostgreSQL DATABASE_URL', () => {
  for (const databaseUrl of [undefined, '', 'not a url']) {
    assert.throws(
      () => loadWorkerEnv({ DATABASE_URL: databaseUrl }),
      /DATABASE_URL must be a postgresql:\/\/ connection string/,
    );
  }
});

await test('worker configuration rejects missing Azure AI credentials without leaking values', () => {
  const source = {
    DATABASE_URL: 'postgresql://db.internal/litebot',
    AZURE_AI_FOUNDRY_API_KEY: 'do-not-leak-this-key',
  };
  assert.throws(
    () => loadWorkerEnv(source),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AZURE_AI_FOUNDRY_ENDPOINT/);
      assert.doesNotMatch(error.message, /do-not-leak-this-key/);
      return true;
    },
  );
  assert.throws(
    () =>
      loadWorkerEnv({
        DATABASE_URL: source.DATABASE_URL,
        AZURE_AI_FOUNDRY_ENDPOINT: 'https://foundry.example.com/openai/v1/',
      }),
    /AZURE_AI_FOUNDRY_API_KEY/,
  );
});

await test('worker configuration requires an HTTPS Azure AI Foundry endpoint', () => {
  assert.throws(
    () =>
      loadWorkerEnv({
        DATABASE_URL: 'postgresql://db.internal/litebot',
        AZURE_AI_FOUNDRY_ENDPOINT: 'http://foundry.example.com',
        AZURE_AI_FOUNDRY_API_KEY: 'synthetic-key',
      }),
    /AZURE_AI_FOUNDRY_ENDPOINT must be a valid HTTPS Foundry OpenAI v1 URL/,
  );
});

await test('worker configuration requires the Foundry OpenAI v1 endpoint path', () => {
  assert.throws(
    () =>
      loadWorkerEnv({
        DATABASE_URL: 'postgresql://db.internal/litebot',
        AZURE_AI_FOUNDRY_ENDPOINT: 'https://foundry.example.com/',
        AZURE_AI_FOUNDRY_API_KEY: 'synthetic-key',
      }),
    /AZURE_AI_FOUNDRY_ENDPOINT must be a valid HTTPS Foundry OpenAI v1 URL/,
  );
});

await test('worker configuration rejects unsupported AI providers', () => {
  assert.throws(
    () =>
      loadWorkerEnv({
        DATABASE_URL: 'postgresql://db.internal/litebot',
        AI_PROVIDER: 'unsupported-provider',
        AZURE_AI_FOUNDRY_ENDPOINT: 'https://foundry.example.com/openai/v1/',
        AZURE_AI_FOUNDRY_API_KEY: 'synthetic-key',
      }),
    /AI_PROVIDER must be azure-foundry/,
  );
});

for (const provider of ['openai', 'gemini'] as const) {
  await test(`worker configuration accepts ${provider} without Azure credentials`, () => {
    const worker = loadWorkerEnv({
      DATABASE_URL: 'postgresql://db.internal/litebot',
      AI_PROVIDER: provider,
    });
    assert.deepEqual(worker.ai, { provider, modelName: provider });
  });
}
