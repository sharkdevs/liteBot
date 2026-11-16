import type { IAiProvider } from './ai-provider.js';

export class OpenAIProvider implements IAiProvider {
  readonly generateResponse: IAiProvider['generateResponse'] = () =>
    Promise.reject(new Error('Not implemented'));
}
