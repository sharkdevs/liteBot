import type { Message } from '../../domain/message/message.js';

export interface IAiProvider {
  generateResponse(userMessage: string, conversationHistory: Message[]): Promise<string>;
}
