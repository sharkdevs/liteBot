import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { pino } from 'pino';

import { createApp } from '../src/app.js';
import type {
  IConversationService,
  InboundTextMessage,
} from '../src/services/conversation.service.js';
import type {
  IncomingMessageJob,
  IncomingMessageQueuePort,
} from '../src/shared/types/incoming-message-job.js';
import { signWebhook, webhookAppSecret } from './support/queue-fixture.js';

const verifyToken = 'test-webhook-verification-token';

interface AppOverrides {
  queue?: IncomingMessageQueuePort;
  conversationService?: IConversationService;
}

for (const whatsappAppSecret of ['', ' \t ']) {
  await test('createApp refuses a blank WhatsApp app secret', () => {
    assert.throws(
      () =>
        createApp({
          logger: pino({ level: 'silent' }),
          whatsappVerifyToken: verifyToken,
          whatsappAppSecret,
          conversationService: {
            recordInboundMessage: () => Promise.reject(new Error('Must not save data')),
            getRecentMessages: () => Promise.resolve([]),
            saveOutboundMessage: () => Promise.reject(new Error('Must not save data')),
          },
          incomingMessageQueue: {
            enqueue: () => Promise.reject(new Error('Must not enqueue jobs')),
          },
        }),
      /WHATSAPP_APP_SECRET must be configured with a non-empty value/,
    );
  });
}

async function startApp(t: TestContext, overrides: AppOverrides = {}) {
  const logs: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({}, destination);
  const jobs: IncomingMessageJob[] = [];
  const recorded: InboundTextMessage[] = [];
  const calls: string[] = [];
  const incomingMessageQueue = overrides.queue ?? {
    enqueue(messages: IncomingMessageJob[]) {
      calls.push('enqueue');
      jobs.push(...messages);
      return Promise.resolve();
    },
  };
  // Deterministic stand-in IDs, so tests can tell which saved message a job refers to.
  const conversationService = overrides.conversationService ?? {
    recordInboundMessage(message: InboundTextMessage) {
      calls.push(`record:${message.whatsappMessageId}`);
      recorded.push(message);
      return Promise.resolve({
        userId: `user-${message.phoneNumber}`,
        conversationId: `conversation-${message.phoneNumber}`,
        messageId: `message-${message.whatsappMessageId}`,
        duplicate: false,
      });
    },
    getRecentMessages: () => Promise.resolve([]),
    saveOutboundMessage: () => Promise.reject(new Error('Webhook tests must not save replies')),
  };
  const server = createApp({
    logger,
    whatsappVerifyToken: verifyToken,
    whatsappAppSecret: webhookAppSecret,
    conversationService,
    incomingMessageQueue,
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    await promisify(server.close.bind(server))();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${String(address.port)}/webhook`,
    logs,
    logger,
    jobs,
    recorded,
    calls,
  };
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

function signedWebhookRequest(url: string, options: RequestInit & { body: string }) {
  const headers = new Headers(options.headers);
  headers.set('x-hub-signature-256', signWebhook(options.body));
  return fetch(url, { ...options, headers });
}

for (const signature of [
  undefined,
  '',
  `sha256=${'a'.repeat(63)}`,
  `sha256=${'a'.repeat(65)}`,
  `sha256=${'z'.repeat(64)}`,
  `sha1=${'a'.repeat(64)}`,
  `SHA256=${'a'.repeat(64)}`,
  `${signWebhook('{}')}, ${signWebhook('{}')}`,
  signWebhook('{}'),
]) {
  await test(`POST rejects an invalid signature before saving or queueing: ${String(signature)}`, async (t) => {
    const { url, jobs, recorded, calls, logs } = await startApp(t);
    const body = JSON.stringify({
      ...payloadWith({ messages: [textMessage()] }),
      webhookVerified: true,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-correlation-id': 'signature-rejection',
    };
    if (signature !== undefined) {
      headers['x-hub-signature-256'] = signature;
    }
    const response = await fetch(url, { method: 'POST', headers, body });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Forbidden' });
    assert.equal(response.headers.get('x-correlation-id'), 'signature-rejection');
    assert.deepEqual(recorded, []);
    assert.deepEqual(jobs, []);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(logs.join(''), /PRIVATE_QUEUED_TEXT|WhatsApp webhook payload received/);
    assert.ok(!logs.join('').includes(webhookAppSecret));
    if (signature) {
      assert.ok(!logs.join('').includes(signature));
    }
  });
}

await test('POST authenticates the original UTF-8 bytes before parsing JSON', async (t) => {
  const { url, recorded, jobs, logs } = await startApp(t);
  const content = 'PRIVATE_UNICODE_TEXT Привет 🌍';
  const body = JSON.stringify(
    payloadWith({ messages: [{ ...textMessage(), text: { body: content } }] }),
    null,
    2,
  );
  const signature = signWebhook(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Hub-Signature-256': signature },
    body,
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.equal(recorded[0]?.content, content);
  assert.equal(jobs[0]?.webhookVerified, true);
  assert.doesNotMatch(logs.join(''), /PRIVATE_UNICODE_TEXT/);
  assert.ok(!logs.join('').includes(signature));
  assert.ok(!logs.join('').includes(webhookAppSecret));
});

await test('POST rejects changed bytes even when the JSON has the same meaning', async (t) => {
  const { url, recorded, jobs } = await startApp(t);
  const payload = payloadWith({ messages: [textMessage()] });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signWebhook(JSON.stringify(payload)),
    },
    body: JSON.stringify(payload, null, 2),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Forbidden' });
  assert.deepEqual(recorded, []);
  assert.deepEqual(jobs, []);
});

await test('POST checks authenticity before reporting malformed JSON', async (t) => {
  const { url, recorded, jobs, logs } = await startApp(t);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signWebhook('{}'),
    },
    body: '{"private":"PRIVATE_UNSIGNED_JSON",',
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Forbidden' });
  assert.deepEqual(recorded, []);
  assert.deepEqual(jobs, []);
  assert.doesNotMatch(logs.join(''), /PRIVATE_UNSIGNED_JSON/);
});

for (const signCompressedBytes of [false, true]) {
  await test(`POST rejects compressed bodies without inflating them (compressed signature: ${String(signCompressedBytes)})`, async (t) => {
    const { url, recorded, jobs } = await startApp(t);
    const body = JSON.stringify(payloadWith({ messages: [textMessage()] }));
    const compressed = gzipSync(body);
    const signature = signCompressedBytes
      ? `sha256=${createHmac('sha256', webhookAppSecret).update(compressed).digest('hex')}`
      : signWebhook(body);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-hub-signature-256': signature,
      },
      body: compressed,
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Forbidden' });
    assert.deepEqual(recorded, []);
    assert.deepEqual(jobs, []);
  });
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
        timestamp: '1794844800',
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

  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
  const output = logs.join('');
  assert.match(output, /WhatsApp webhook payload received/);
  assert.match(
    output,
    /"eventType":"messages","phoneNumber":"15550000001","whatsappMessageId":"wamid.first"/,
  );
  assert.match(
    output,
    /"eventType":"messages","phoneNumber":"15550000002","whatsappMessageId":"wamid.second"/,
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
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.match(logs.join(''), /"eventType":"messages","whatsappMessageId":"wamid.no-phone"/);
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
    const response = await signedWebhookRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed request' });
    assert.doesNotMatch(logs.join(''), /WhatsApp webhook payload received/);
  });
}

await test('POST rejects a malformed later entry before logging any accepted payload', async (t) => {
  const { url, logs } = await startApp(t);
  const payload = payloadWith({ messages: [{ id: 'wamid.valid' }] });
  payload.entry.push({ id: 'invalid-account', changes: [] });
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 400);
  await response.text();
  assert.doesNotMatch(logs.join(''), /WhatsApp webhook payload received|"whatsappMessageId":/);
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
    const response = await signedWebhookRequest(url, {
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
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payloadWith({ messages: [{ id: 'wamid.example' }] })),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});

function textMessage(id = 'wamid.queued') {
  return {
    id,
    from: '15550000001',
    type: 'text',
    text: { body: 'PRIVATE_QUEUED_TEXT' },
    timestamp: '1794844800',
  };
}

await test('POST saves each text message, then enqueues jobs carrying its database IDs', async (t) => {
  const { url, jobs, recorded, calls, logs } = await startApp(t);
  const payload = payloadWith({ messages: [textMessage('wamid.first')] });
  payload.entry.push(...payloadWith({ messages: [textMessage('wamid.second')] }).entry);
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'webhook-queue-test' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
  assert.equal(response.headers.get('x-correlation-id'), 'webhook-queue-test');
  assert.deepEqual(calls, ['record:wamid.first', 'record:wamid.second', 'enqueue']);
  assert.deepEqual(
    recorded,
    ['wamid.first', 'wamid.second'].map((whatsappMessageId) => ({
      correlationId: 'webhook-queue-test',
      phoneNumber: '15550000001',
      whatsappMessageId,
      whatsappTimestamp: new Date('2026-11-16T16:00:00Z'),
      content: 'PRIVATE_QUEUED_TEXT',
    })),
  );
  assert.deepEqual(
    jobs,
    ['wamid.first', 'wamid.second'].map((whatsappMessageId) => ({
      webhookVerified: true,
      correlationId: 'webhook-queue-test',
      messageId: `message-${whatsappMessageId}`,
      userId: 'user-15550000001',
      conversationId: 'conversation-15550000001',
      whatsappMessageId,
      phoneNumber: '15550000001',
      messageText: 'PRIVATE_QUEUED_TEXT',
      timestamp: '1794844800',
    })),
  );
  assert.doesNotMatch(logs.join(''), /PRIVATE_QUEUED_TEXT/);
});

await test('POST returns 500 and enqueues nothing when saving a message fails', async (t) => {
  const { url, jobs, logs } = await startApp(t, {
    conversationService: {
      recordInboundMessage: () => Promise.reject(new Error('PRIVATE_DATABASE_FAILURE')),
      getRecentMessages: () => Promise.resolve([]),
      saveOutboundMessage: () => Promise.reject(new Error('Webhook tests must not save replies')),
    },
  });
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'database-failure-test' },
    body: JSON.stringify(payloadWith({ messages: [textMessage()] })),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
  assert.deepEqual(jobs, []);
  assert.match(logs.join(''), /"correlationId":"database-failure-test"/);
});

await test('POST reports queue failure as 500 instead of acknowledging lost work', async (t) => {
  const { url, logs } = await startApp(t, {
    queue: { enqueue: () => Promise.reject(new Error('PRIVATE_QUEUE_FAILURE')) },
  });
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'queue-failure-test' },
    body: JSON.stringify(payloadWith({ messages: [textMessage()] })),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
  assert.match(logs.join(''), /"correlationId":"queue-failure-test"/);
});

await test('POST rejects a malformed later text message before saving or enqueueing', async (t) => {
  const { url, jobs, recorded } = await startApp(t);
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      payloadWith({
        messages: [textMessage(), { ...textMessage('wamid.invalid'), text: { body: 42 } }],
      }),
    ),
  });
  assert.equal(response.status, 400);
  await response.text();
  assert.deepEqual(recorded, []);
  assert.deepEqual(jobs, []);
});

// The last value is one second past the latest moment a JavaScript Date can represent.
for (const timestamp of [undefined, 'not-a-timestamp', '-1', 1794844800, '8640000000001']) {
  await test(`POST rejects an invalid text-message timestamp: ${String(timestamp)}`, async (t) => {
    const { url, jobs } = await startApp(t);
    const response = await signedWebhookRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadWith({ messages: [{ ...textMessage(), timestamp }] })),
    });
    assert.equal(response.status, 400);
    await response.text();
    assert.deepEqual(jobs, []);
  });
}

await test('POST acknowledges statuses, non-text and phone-less messages without saving or queueing', async (t) => {
  const { url, jobs, recorded, logs } = await startApp(t);
  const payload = payloadWith({
    messages: [
      { id: 'wamid.image', from: '15550000001', type: 'image' },
      { ...textMessage('wamid.no-phone'), from: undefined },
    ],
  });
  payload.entry.push(...payloadWith({ statuses: [{ status: 'delivered' }] }).entry);
  const response = await signedWebhookRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(recorded, []);
  assert.deepEqual(jobs, []);
  assert.match(logs.join(''), /unsupported_message_type/);
  assert.match(logs.join(''), /missing_phone_number/);
});

for (const supplied of [undefined, 'unsafe/correlation/value']) {
  await test(`requests generate a safe correlation ID for ${String(supplied)}`, async (t) => {
    const { url } = await startApp(t);
    const response = await fetch(url, {
      headers: supplied ? { 'x-correlation-id': supplied } : {},
    });
    assert.equal(response.status, 403);
    assert.match(response.headers.get('x-correlation-id') ?? '', /^[a-f0-9-]{36}$/);
    await response.text();
  });
}
