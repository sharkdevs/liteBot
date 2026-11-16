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
