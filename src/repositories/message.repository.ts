import type { DatabaseClient } from '../config/database.js';
import type { Message, NewMessage } from '../domain/message/message.js';

export interface IMessageRepository {
  /** Finds a message by Meta's ID, to recognize a webhook that Meta delivered again. */
  findByWhatsappMessageId(whatsappMessageId: string): Promise<Message | null>;
  create(message: NewMessage): Promise<Message>;
}

export class MessageRepository implements IMessageRepository {
  constructor(private readonly db: DatabaseClient) {}

  findByWhatsappMessageId(whatsappMessageId: string): Promise<Message | null> {
    return this.db.message.findUnique({ where: { whatsappMessageId } });
  }

  create(message: NewMessage): Promise<Message> {
    return this.db.message.create({ data: message });
  }
}
