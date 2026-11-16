import { MessageDirection, type Message } from '../domain/message/message.js';
import { SYSTEM_PROMPT } from './system.prompt.js';

const MAX_CONVERSATION_MESSAGES = 20;

export type ChatMessage = {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
};

export class PromptBuilder {
  build(history: readonly Message[], currentUserMessage: string): ChatMessage[] {
    const recentHistory = [...history]
      .sort((first, second) => first.createdAt.getTime() - second.createdAt.getTime())
      .slice(-(MAX_CONVERSATION_MESSAGES - 1));

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      ...recentHistory.map((message): ChatMessage => ({
        role: message.direction === MessageDirection.INBOUND ? 'user' : 'assistant',
        content: message.content,
      })),
      { role: 'user', content: currentUserMessage },
    ];
  }
}
