import type { DatabaseClient } from '../config/database.js';
import {
  MessageDirection,
  MessageStatus,
  type Message,
  type NewMessage,
} from '../domain/message/message.js';

export interface IMessageRepository {
  /** Finds a message by Meta's ID, to recognize a webhook that Meta delivered again. */
  findByWhatsappMessageId(whatsappMessageId: string): Promise<Message | null>;
  findRecentMessagesByConversation(
    conversationId: string,
    limit: number,
    excludeMessageId?: string,
  ): Promise<Message[]>;
  saveOutboundMessage(
    conversationId: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<Message>;
  findReplyToMessage(replyToMessageId: string): Promise<Message | null>;
  findById(id: string): Promise<Message | null>;
  markSent(id: string, providerResponseId: string): Promise<void>;
  markFailed(id: string): Promise<void>;
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

  saveOutboundMessage(
    conversationId: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<Message> {
    const data = {
      conversationId,
      whatsappMessageId: null,
      direction: MessageDirection.OUTBOUND,
      status: MessageStatus.PENDING,
      content,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    };
    if (replyToMessageId === undefined) {
      return this.db.message.create({ data });
    }
    return this.db.message.upsert({ where: { replyToMessageId }, create: data, update: {} });
  }

  findReplyToMessage(replyToMessageId: string): Promise<Message | null> {
    return this.db.message.findUnique({ where: { replyToMessageId } });
  }

  findById(id: string): Promise<Message | null> {
    return this.db.message.findUnique({ where: { id } });
  }

  async markSent(id: string, providerResponseId: string): Promise<void> {
    await this.db.message.update({
      where: { id, direction: MessageDirection.OUTBOUND },
      data: { status: MessageStatus.SENT, whatsappMessageId: providerResponseId },
    });
  }

  async markFailed(id: string): Promise<void> {
    const result = await this.db.message.updateMany({
      where: { id, direction: MessageDirection.OUTBOUND, status: { not: MessageStatus.SENT } },
      data: { status: MessageStatus.FAILED },
    });
    if (result.count === 0) {
      // Only a previously recorded acceptance may make this a no-op.
      await this.db.message.findUniqueOrThrow({
        where: { id, direction: MessageDirection.OUTBOUND, status: MessageStatus.SENT },
      });
    }
  }

  create(message: NewMessage): Promise<Message> {
    return this.db.message.create({
      data: {
        ...message,
        status: message.direction === MessageDirection.OUTBOUND ? MessageStatus.PENDING : null,
      },
    });
  }
}
