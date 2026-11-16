import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MessageDirection, type Message } from '../src/domain/message/message.js';
import { SYSTEM_PROMPT } from '../src/prompts/system.prompt.js';
import { PromptBuilder } from '../src/prompts/prompt-builder.js';

function message(
  id: string,
  direction: Message['direction'],
  content: string,
  createdAt: string,
): Message {
  return {
    id,
    conversationId: 'conversation-1',
    whatsappMessageId: null,
    direction,
    content,
    createdAt: new Date(createdAt),
  };
}

await test('builds a prompt with the system prompt and chronological role-mapped history', () => {
  assert.equal(SYSTEM_PROMPT, 'You are a helpful WhatsApp assistant.');

  const history = [
    message('assistant-1', MessageDirection.OUTBOUND, 'Earlier reply', '2026-01-02T00:00:00Z'),
    message('user-1', MessageDirection.INBOUND, 'Earlier question', '2026-01-01T00:00:00Z'),
  ];

  const prompt = new PromptBuilder().build(history, 'Current question');

  assert.deepEqual(prompt, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier reply' },
    { role: 'user', content: 'Current question' },
  ]);
});

await test('caps conversational messages at 20 and keeps the most recent prior context', () => {
  const history = Array.from({ length: 25 }, (_, index) =>
    message(
      `message-${String(index)}`,
      index % 2 === 0 ? MessageDirection.INBOUND : MessageDirection.OUTBOUND,
      `Message ${String(index)}`,
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    ),
  );

  const prompt = new PromptBuilder().build(history, 'Current question');

  assert.equal(prompt[0]?.role, 'system');
  assert.equal(prompt.length, 21);
  assert.deepEqual(
    prompt.slice(1).map(({ content }) => content),
    [
      ...Array.from({ length: 19 }, (_, index) => `Message ${String(index + 6)}`),
      'Current question',
    ],
  );
  assert.equal(prompt.at(-1)?.role, 'user');
});
