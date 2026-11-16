import OpenAI from 'openai';

import type { AzureFoundrySettings } from '../../config/env.js';
import type { Message } from '../../domain/message/message.js';
import type { PromptBuilder } from '../../prompts/prompt-builder.js';
import type { IAiProvider } from './ai-provider.js';

type OpenAIFetch = NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'];

export class AzureAiFoundryProvider implements IAiProvider {
  private readonly client: OpenAI;
  readonly modelName: string;

  constructor(
    settings: AzureFoundrySettings,
    private readonly promptBuilder: PromptBuilder,
    fetchImpl?: OpenAIFetch,
  ) {
    this.modelName = settings.modelName;
    this.client = new OpenAI({
      baseURL: settings.endpoint,
      apiKey: settings.apiKey,
      timeout: 30_000,
      // BullMQ owns retries; SDK retries would multiply each queue attempt.
      maxRetries: 0,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  }

  async generateResponse(userMessage: string, conversationHistory: Message[]): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.modelName,
      messages: this.promptBuilder.build(conversationHistory, userMessage),
    });
    const content = completion.choices[0]?.message.content;

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Azure AI Foundry returned an empty response');
    }

    return content;
  }
}
