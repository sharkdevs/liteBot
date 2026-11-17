import type { DatabaseClient } from '../config/database.js';
import type { OutgoingMessageJob } from '../shared/types/outgoing-message-job.js';
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
    dispatchCorrelationId?: string,
  ): Promise<Message>;
  findPendingDispatches(afterId?: string): Promise<OutgoingMessageJob[]>;
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
    dispatchCorrelationId?: string,
  ): Promise<Message> {
    if (dispatchCorrelationId !== undefined && replyToMessageId === undefined) {
      throw new Error('Dispatch intent requires an inbound reply link');
    }
    const data = {
      conversationId,
      whatsappMessageId: null,
      direction: MessageDirection.OUTBOUND,
      status: MessageStatus.PENDING,
      content,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      ...(dispatchCorrelationId === undefined ? {} : { dispatchCorrelationId }),
    };
    if (replyToMessageId === undefined) {
      return this.db.message.create({ data });
    }
    return this.db.message.upsert({
      where: { replyToMessageId },
      create: data,
      // A nonempty conflict update keeps Prisma's upsert atomic without replacing the reply.
      update: { replyToMessageId },
    });
  }

  findReplyToMessage(replyToMessageId: string): Promise<Message | null> {
    return this.db.message.findUnique({ where: { replyToMessageId } });
  }

  async findPendingDispatches(afterId?: string): Promise<OutgoingMessageJob[]> {
    const rows = await this.db.message.findMany({
      where: {
        status: MessageStatus.PENDING,
        direction: MessageDirection.OUTBOUND,
        dispatchCorrelationId: { not: null },
        ...(afterId === undefined ? {} : { id: { gt: afterId } }),
      },
      include: { conversation: { include: { user: true } } },
      orderBy: { id: 'asc' },
      take: 100,
    });
    return rows.map((row) => {
      if (row.dispatchCorrelationId === null) throw new Error('Missing dispatch correlation');
      return {
        messageId: row.id,
        conversationId: row.conversationId,
        content: row.content,
        correlationId: row.dispatchCorrelationId,
        userId: row.conversation.userId,
        phoneNumber: row.conversation.user.phoneNumber,
      };
    });
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
      where: {
        id,
        direction: MessageDirection.OUTBOUND,
        status: { in: [MessageStatus.PENDING, MessageStatus.FAILED] },
      },
      data: { status: MessageStatus.FAILED },
    });
    if (result.count === 0) {
      // A stale failure must not overwrite confirmed or uncertain acceptance.
      await this.db.message.findUniqueOrThrow({
        where: {
          id,
          direction: MessageDirection.OUTBOUND,
          status: { in: [MessageStatus.SENT, MessageStatus.UNKNOWN] },
        },
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
