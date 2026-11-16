import type { DatabaseClient } from '../config/database.js';
import { MessageDirection, type Message, type NewMessage } from '../domain/message/message.js';

export interface IMessageRepository {
  /** Finds a message by Meta's ID, to recognize a webhook that Meta delivered again. */
  findByWhatsappMessageId(whatsappMessageId: string): Promise<Message | null>;
  findRecentMessagesByConversation(
    conversationId: string,
    limit: number,
    excludeMessageId?: string,
  ): Promise<Message[]>;
  saveOutboundMessage(conversationId: string, content: string): Promise<Message>;
  create(message: NewMessage): Promise<Message>;
}

export class MessageRepository implements IMessageRepository {
  constructor(private readonly db: DatabaseClient) {}

  findByWhatsappMessageId(whatsappMessageId: string): Promise<Message | null> {
    return this.db.message.findUnique({ where: { whatsappMessageId } });
  }

  async findRecentMessagesByConversation(
    conversationId: string,
    limit: number,
    excludeMessageId?: string,
  ): Promise<Message[]> {
    const messages = await this.db.message.findMany({
      where: {
        conversationId,
        ...(excludeMessageId === undefined ? {} : { id: { not: excludeMessageId } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return messages.reverse();
  }

  saveOutboundMessage(conversationId: string, content: string): Promise<Message> {
    return this.create({
      conversationId,
      whatsappMessageId: null,
      direction: MessageDirection.OUTBOUND,
      content,
    });
  }

  create(message: NewMessage): Promise<Message> {
    return this.db.message.create({ data: message });
  }
}
