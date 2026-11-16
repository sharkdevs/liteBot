import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';

import { loadWhatsAppWorkerEnv } from '../src/config/env.js';
import { WhatsAppCloudApiProvider } from '../src/providers/whatsapp/whatsapp-cloud-api.provider.js';
import { WhatsAppProviderError } from '../src/providers/whatsapp/whatsapp-provider.js';

const settings = { accessToken: 'PRIVATE_TOKEN', phoneNumberId: '123456789' };

await test('WhatsApp worker loads only database, Redis and sending credentials', () => {
  const env = loadWhatsAppWorkerEnv({
    DATABASE_URL: 'postgresql://db.internal/litebot',
    WHATSAPP_ACCESS_TOKEN: settings.accessToken,
    WHATSAPP_PHONE_NUMBER_ID: settings.phoneNumberId,
    AI_PROVIDER: 'invalid-unused-provider',
    PORT: 'invalid-unused-port',
  });
  assert.deepEqual(env.whatsapp, settings);
  assert.ok(!('ai' in env));
  for (const invalid of [
    { WHATSAPP_ACCESS_TOKEN: '' },
    { WHATSAPP_ACCESS_TOKEN: 'PRIVATE_TOKEN\ninjected' },
    { WHATSAPP_PHONE_NUMBER_ID: '' },
    { WHATSAPP_PHONE_NUMBER_ID: '../PRIVATE_ID' },
  ]) {
    assert.throws(
      () =>
        loadWhatsAppWorkerEnv({
          DATABASE_URL: 'postgresql://db.internal/litebot',
          WHATSAPP_ACCESS_TOKEN: settings.accessToken,
          WHATSAPP_PHONE_NUMBER_ID: settings.phoneNumberId,
          ...invalid,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /WHATSAPP_/);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      },
    );
  }
});

await test('Cloud API sends an authenticated text request and returns only the receipt ID', async () => {
  const provider = new WhatsAppCloudApiProvider(settings, (url, init) => {
    assert.equal(url, 'https://graph.facebook.com/v26.0/123456789/messages');
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${settings.accessToken}`);
    assert.ok(init.signal);
    assert.ok(typeof init.body === 'string');
    assert.deepEqual(JSON.parse(init.body), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550000001',
      type: 'text',
      text: { body: 'Private reply', preview_url: false },
    });
    return Promise.resolve(
      Response.json({ messages: [{ id: 'wamid.receipt' }], ignored: 'unmodeled response data' }),
    );
  });
  assert.deepEqual(await provider.sendTextMessage('15550000001', 'Private reply'), {
    providerResponseId: 'wamid.receipt',
  });
});

await test('Cloud API classifies transient and permanent errors without leaking response bodies', async () => {
  for (const [status, code, transient] of [
    [503, undefined, true],
    [429, undefined, true],
    [408, undefined, true],
    [400, 130429, true],
    [400, 131056, true],
    [400, 131000, true],
    [400, 131016, true],
    [401, 190, false],
    [400, 131047, false],
    [400, 131048, false],
    [400, 131009, false],
  ] as const) {
    let calls = 0;
    const provider = new WhatsAppCloudApiProvider(settings, () => {
      calls++;
      return Promise.resolve(
        Response.json({ error: { code, message: 'PRIVATE_ERROR_BODY' } }, { status }),
      );
    });
    await assert.rejects(
      provider.sendTextMessage('15550000001', 'Private reply'),
      (error: unknown) => {
        assert.ok(error instanceof WhatsAppProviderError);
        assert.equal(error.retryable, transient);
        assert.equal(error.httpStatus, status);
        assert.equal(error.apiCode, code);
        assert.doesNotMatch(inspect(error), /PRIVATE_ERROR_BODY|PRIVATE_TOKEN|Private reply/);
        return true;
      },
    );
    assert.equal(calls, 1, 'BullMQ, not the HTTP client, owns retries');
  }
});

await test('Cloud API rejects malformed acceptance responses and non-JSON failures safely', async () => {
  for (const response of [
    Response.json({ messages: [] }),
    Response.json({ messages: [{ id: '' }] }),
    new Response('PRIVATE_INVALID_JSON'),
    new Response('PRIVATE_HTML_ERROR', { status: 502 }),
  ]) {
    const provider = new WhatsAppCloudApiProvider(settings, () => Promise.resolve(response));
    await assert.rejects(
      provider.sendTextMessage('15550000001', 'Private reply'),
      (error: unknown) => {
        assert.ok(error instanceof WhatsAppProviderError);
        assert.doesNotMatch(inspect(error), /PRIVATE_/);
        return true;
      },
    );
  }
});

await test('Cloud API aborts a stalled request and sanitizes network errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new WhatsAppCloudApiProvider(settings, (_url, init) => {
    assert.ok(init?.signal);
    t.mock.timers.tick(10_000);
    assert.equal(init.signal.aborted, true);
    return Promise.reject(new Error('PRIVATE_NETWORK_DETAILS'));
  });
  await assert.rejects(
    provider.sendTextMessage('15550000001', 'Private reply'),
    (error: unknown) => {
      assert.ok(error instanceof WhatsAppProviderError);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(inspect(error), /PRIVATE_NETWORK_DETAILS/);
      return true;
    },
  );
});

await test('Cloud API rejects invalid recipients and oversized/empty text before HTTP', async () => {
  const provider = new WhatsAppCloudApiProvider(settings, () => {
    assert.fail('Invalid input must not reach Meta');
  });
  for (const [phone, text] of [
    ['not-a-phone', 'hello'],
    ['15550000001', ''],
    ['15550000001', ' '.repeat(5)],
    ['15550000001', 'x'.repeat(4097)],
  ]) {
    await assert.rejects(provider.sendTextMessage(phone ?? '', text ?? ''), (error: unknown) => {
      assert.ok(error instanceof WhatsAppProviderError);
      assert.equal(error.retryable, false);
      return true;
    });
  }
});
