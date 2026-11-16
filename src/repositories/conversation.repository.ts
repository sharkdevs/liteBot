import type { DatabaseClient } from '../config/database.js';
import type { Conversation, NewConversation } from '../domain/conversation/conversation.js';

export interface IConversationRepository {
  findLatestForUser(userId: string): Promise<Conversation | null>;
  create(conversation: NewConversation): Promise<Conversation>;
}

export class ConversationRepository implements IConversationRepository {
  constructor(private readonly db: DatabaseClient) {}

  /** The user's most recently created conversation, or `null` if they have none. */
  findLatestForUser(userId: string): Promise<Conversation | null> {
    return this.db.conversation.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  create(conversation: NewConversation): Promise<Conversation> {
    return this.db.conversation.create({ data: conversation });
  }
}
