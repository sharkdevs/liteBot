import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { pino } from 'pino';

import { createApp } from '../src/app.js';

const verifyToken = 'test-webhook-verification-token';

async function startApp(t: TestContext) {
  const logs: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({}, destination);
  const server = createApp({ logger, whatsappVerifyToken: verifyToken }).listen(0, '127.0.0.1');
  t.after(async () => {
    await promisify(server.close.bind(server))();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${String(address.port)}/webhook`, logs, logger };
}

await test('verification echoes the challenge as plain text without logging secrets', async (t) => {
  const { url, logs } = await startApp(t);
  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': verifyToken,
    'hub.challenge': '000742',
  });
  const response = await fetch(`${url}?${query.toString()}`, {
    headers: { authorization: 'Bearer private-access-token', cookie: 'session=private-cookie' },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await response.text(), '000742');
  assert.doesNotMatch(
    logs.join(''),
    /test-webhook-verification-token|private-access-token|private-cookie/,
  );
});

for (const query of [
  'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42',
  'hub.mode=unsubscribe&hub.verify_token=test-webhook-verification-token&hub.challenge=42',
  'hub.mode=subscribe&hub.challenge=42',
  'hub.mode=subscribe&hub.verify_token=&hub.challenge=42',
  'hub.mode=subscribe&hub.verify_token=test-webhook-verification-token&hub.verify_token=other&hub.challenge=42',
]) {
  await test(`verification rejects an invalid mode or token: ${query}`, async (t) => {
    const { url } = await startApp(t);
    const response = await fetch(`${url}?${query}`);
    assert.equal(response.status, 403);
    await response.text();
  });
}

for (const challenge of ['', '&hub.challenge=', '&hub.challenge=42&hub.challenge=43']) {
  await test(`verification rejects a missing or ambiguous challenge: ${challenge}`, async (t) => {
    const { url } = await startApp(t);
    const response = await fetch(
      `${url}?hub.mode=subscribe&hub.verify_token=${verifyToken}${challenge}`,
    );
    assert.equal(response.status, 400);
    await response.text();
  });
}

function payloadWith(value: unknown) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'business-account', changes: [{ field: 'messages', value }] }],
  };
}

await test('POST acknowledges a batch and logs only the validated payload metadata', async (t) => {
  const { url, logs } = await startApp(t);
  const payload = payloadWith({
    messaging_product: 'whatsapp',
    messages: [
      {
        id: 'wamid.first',
        from: '15550000001',
        type: 'text',
        text: { body: 'PRIVATE_MESSAGE_TEXT' },
        unexpected_secret: 'PRIVATE_UNKNOWN_FIELD',
      },
    ],
    contacts: [{ profile: { name: 'PRIVATE_CONTACT_PROFILE' } }],
  });
  payload.entry.push(
    ...payloadWith({
      messages: [{ id: 'wamid.second', from: '15550000002' }],
    }).entry,
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
  const output = logs.join('');
  assert.match(output, /"payload":\{"object":"whatsapp_business_account"/);
  assert.match(
    output,
    /"eventType":"messages","phoneNumber":"15550000001","messageId":"wamid.first"/,
  );
  assert.match(
    output,
    /"eventType":"messages","phoneNumber":"15550000002","messageId":"wamid.second"/,
  );
  assert.doesNotMatch(output, /PRIVATE_MESSAGE_TEXT|PRIVATE_CONTACT_PROFILE|PRIVATE_UNKNOWN_FIELD/);
});

await test('POST accepts a message without a phone number and status-only changes', async (t) => {
  const { url, logs } = await startApp(t);
  const payload = payloadWith({
    messages: [{ id: 'wamid.no-phone', from_user_id: 'bsuid.example' }],
  });
  payload.entry.push(
    ...payloadWith({ statuses: [{ id: 'wamid.delivery', status: 'delivered' }] }).entry,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.match(logs.join(''), /"eventType":"messages","messageId":"wamid.no-phone"/);
  assert.doesNotMatch(logs.join(''), /"phoneNumber"/);
});

const malformedPayloads: { name: string; body: unknown }[] = [
  { name: 'null body', body: null },
  { name: 'missing envelope', body: {} },
  { name: 'wrong object type', body: { ...payloadWith({}), object: 'page' } },
  { name: 'entry is not an array', body: { object: 'whatsapp_business_account', entry: {} } },
  { name: 'empty entries', body: { object: 'whatsapp_business_account', entry: [] } },
  { name: 'null entry', body: { object: 'whatsapp_business_account', entry: [null] } },
  {
    name: 'missing entry id',
    body: { object: 'whatsapp_business_account', entry: [{ changes: [] }] },
  },
  {
    name: 'missing changes',
    body: { object: 'whatsapp_business_account', entry: [{ id: 'account' }] },
  },
  { name: 'null change value', body: payloadWith(null) },
  { name: 'messages is not an array', body: payloadWith({ messages: {} }) },
  { name: 'null message', body: payloadWith({ messages: [null] }) },
  { name: 'message id is missing', body: payloadWith({ messages: [{ from: '15550000001' }] }) },
  {
    name: 'phone number is not a string',
    body: payloadWith({ messages: [{ id: 'wamid', from: 123 }] }),
  },
];

for (const { name, body } of malformedPayloads) {
  await test(`POST returns 400 for ${name}`, async (t) => {
    const { url, logs } = await startApp(t);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed request' });
    assert.doesNotMatch(logs.join(''), /"payload":/);
  });
}

await test('POST rejects a malformed later entry before logging any accepted payload', async (t) => {
  const { url, logs } = await startApp(t);
  const payload = payloadWith({ messages: [{ id: 'wamid.valid' }] });
  payload.entry.push({ id: 'invalid-account', changes: [] });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 400);
  await response.text();
  assert.doesNotMatch(logs.join(''), /"payload":|"messageId":/);
});

for (const { name, body, contentType } of [
  {
    name: 'broken JSON',
    body: '{"private":"PRIVATE_PARSE_BODY",',
    contentType: 'application/json',
  },
  { name: 'wrong content type', body: 'PRIVATE_TEXT_BODY', contentType: 'text/plain' },
  {
    name: 'oversized JSON',
    body: JSON.stringify({ text: 'x'.repeat(110_000) }),
    contentType: 'application/json',
  },
]) {
  await test(`POST maps ${name} to 400 without logging the raw body`, async (t) => {
    const { url, logs } = await startApp(t);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed request' });
    assert.doesNotMatch(logs.join(''), /PRIVATE_PARSE_BODY|PRIVATE_TEXT_BODY|xxxxxxxxxx/);
  });
}

await test('POST returns a generic 500 for an unexpected failure', async (t) => {
  const { url, logger } = await startApp(t);
  t.mock.method(
    logger,
    'info',
    () => {
      throw new Error('PRIVATE_INTERNAL_FAILURE');
    },
    { times: 1 },
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payloadWith({ messages: [{ id: 'wamid.example' }] })),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});
