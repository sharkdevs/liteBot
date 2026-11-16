import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AiSettings } from '../src/config/env.js';
import { MessageDirection, type Message } from '../src/domain/message/message.js';
import { PromptBuilder } from '../src/prompts/prompt-builder.js';
import {
  AzureAiFoundryProvider,
  GeminiProvider,
  OpenAIProvider,
  createAiProvider,
} from '../src/providers/ai/index.js';

const settings: AiSettings = {
  provider: 'azure-foundry',
  endpoint: 'https://foundry.example/openai/v1/',
  apiKey: 'test-api-key',
  modelName: 'deployment-name',
};

const history: Message[] = [
  {
    id: 'prior-message',
    conversationId: 'conversation-1',
    whatsappMessageId: null,
    direction: MessageDirection.INBOUND,
    content: 'Previous question',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
];

function completionResponse(content: string | null): Response {
  return Response.json({
    id: 'completion-1',
    object: 'chat.completion',
    created: 1,
    model: 'deployment-name',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content },
      },
    ],
  });
}

await test('Azure Foundry sends the prompt to the configured chat-completions deployment', async () => {
  let requestUrl = '';
  let authorizationHeader: string | null = null;
  let requestPayload: unknown;
  const provider = new AzureAiFoundryProvider(settings, new PromptBuilder(), (input, init) => {
    requestUrl = input instanceof Request ? input.url : input.toString();
    authorizationHeader = new Headers(init?.headers).get('authorization');
    requestPayload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return Promise.resolve(completionResponse('Generated reply'));
  });

  const result = await provider.generateResponse('Current question', history);

  assert.equal(result, 'Generated reply');
  assert.equal(provider.modelName, 'deployment-name');
  assert.equal(requestUrl, 'https://foundry.example/openai/v1/chat/completions');
  assert.equal(authorizationHeader, 'Bearer test-api-key');
  assert.deepEqual(requestPayload, {
    model: 'deployment-name',
    messages: [
      { role: 'system', content: 'You are a helpful WhatsApp assistant.' },
      { role: 'user', content: 'Previous question' },
      { role: 'user', content: 'Current question' },
    ],
  });
});

await test('Azure Foundry rejects a missing or empty completion message', async () => {
  const responses = [
    completionResponse(null),
    completionResponse(''),
    completionResponse('   '),
    Response.json({ choices: [] }),
  ];

  for (const response of responses) {
    const provider = new AzureAiFoundryProvider(settings, new PromptBuilder(), () =>
      Promise.resolve(response),
    );
    await assert.rejects(provider.generateResponse('Question', []), /empty response/i);
  }
});

await test('Azure Foundry propagates SDK failures', async () => {
  const provider = new AzureAiFoundryProvider(settings, new PromptBuilder(), () =>
    Promise.resolve(Response.json({ error: { message: 'Rejected request' } }, { status: 400 })),
  );

  await assert.rejects(provider.generateResponse('Question', []), /Rejected request/);
});

await test('Azure Foundry aborts a slow request after 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new AzureAiFoundryProvider(settings, new PromptBuilder(), (_input, init) => {
    assert.ok(init?.signal);
    t.mock.timers.tick(30_000);
    if (init.signal.aborted) {
      return Promise.reject(new DOMException('Request aborted', 'AbortError'));
    }
    return Promise.resolve(completionResponse('Late response'));
  });

  await assert.rejects(provider.generateResponse('Question', []), /timed out/i);
});

await test('Azure Foundry leaves retryable failures to the queue instead of retrying internally', async () => {
  let requests = 0;
  const provider = new AzureAiFoundryProvider(settings, new PromptBuilder(), () => {
    requests += 1;
    return Promise.resolve(
      Response.json({ error: { message: 'Temporarily unavailable' } }, { status: 503 }),
    );
  });

  await assert.rejects(provider.generateResponse('Question', []), /Temporarily unavailable/);
  assert.equal(requests, 1);
});

await test('OpenAI and Gemini placeholders reject generation as not implemented', async () => {
  const openAiProvider = new OpenAIProvider();
  const geminiProvider = new GeminiProvider();

  await assert.rejects(openAiProvider.generateResponse('Question', []), {
    message: 'Not implemented',
  });
  await assert.rejects(geminiProvider.generateResponse('Question', []), {
    message: 'Not implemented',
  });
});

await test('factory selects each configured provider and exposes its configured model name', () => {
  const azure = createAiProvider(settings, new PromptBuilder());
  const openAi = createAiProvider({ provider: 'openai', modelName: 'openai' }, new PromptBuilder());
  const gemini = createAiProvider({ provider: 'gemini', modelName: 'gemini' }, new PromptBuilder());

  assert.ok(azure.provider instanceof AzureAiFoundryProvider);
  assert.equal(azure.modelName, 'deployment-name');
  assert.ok(openAi.provider instanceof OpenAIProvider);
  assert.equal(openAi.modelName, 'openai');
  assert.ok(gemini.provider instanceof GeminiProvider);
  assert.equal(gemini.modelName, 'gemini');
});
