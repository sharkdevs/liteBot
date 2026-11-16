import type { AiSettings } from '../../config/env.js';
import type { PromptBuilder } from '../../prompts/prompt-builder.js';
import { AzureAiFoundryProvider } from './azure-ai-foundry.provider.js';
import type { IAiProvider } from './ai-provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { OpenAIProvider } from './openai.provider.js';

export interface AiProviderSelection {
  readonly provider: IAiProvider;
  readonly modelName: string;
}

export function createAiProvider(
  settings: AiSettings,
  promptBuilder: PromptBuilder,
): AiProviderSelection {
  switch (settings.provider) {
    case 'azure-foundry':
      return {
        provider: new AzureAiFoundryProvider(settings, promptBuilder),
        modelName: settings.modelName,
      };
    case 'openai':
      return {
        provider: new OpenAIProvider(),
        modelName: settings.modelName,
      };
    case 'gemini':
      return {
        provider: new GeminiProvider(),
        modelName: settings.modelName,
      };
    default:
      return assertNever(settings);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported AI provider: ${String(value)}`);
}
