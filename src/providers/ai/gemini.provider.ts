import type { IAiProvider } from './ai-provider.js';

export class GeminiProvider implements IAiProvider {
  readonly generateResponse: IAiProvider['generateResponse'] = () =>
    Promise.reject(new Error('Not implemented'));
}
