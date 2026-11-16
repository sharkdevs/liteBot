import type { Logger } from 'pino';

import { MessageDirection } from '../domain/message/message.js';
import type { IUnitOfWork } from '../repositories/unit-of-work.js';

export interface InboundTextMessage {
  readonly correlationId: string;
  readonly phoneNumber: string;
  /** Meta's message ID (`wamid...`). */
  readonly whatsappMessageId: string;
  readonly content: string;
}

export interface RecordedInboundMessage {
  readonly userId: string;
  readonly conversationId: string;
  /** Our database ID for the saved message. */
  readonly messageId: string;
  /** `true` when Meta delivered a message we had already saved. */
  readonly duplicate: boolean;
}

export interface IConversationService {
  recordInboundMessage(message: InboundTextMessage): Promise<RecordedInboundMessage>;
}

export class ConversationService implements IConversationService {
  constructor(
    private readonly unitOfWork: IUnitOfWork,
    private readonly logger: Logger,
  ) {}

  async recordInboundMessage(inbound: InboundTextMessage): Promise<RecordedInboundMessage> {
    const { correlationId, phoneNumber, whatsappMessageId, content } = inbound;

    // One sender's messages are saved one at a time, so two simultaneous first messages
    // cannot both create a user or a conversation.
    const saved = await this.unitOfWork.runExclusive(
      `sender:${phoneNumber}`,
      async ({ users, conversations, messages }) => {
        const existingUser = await users.findByPhoneNumber(phoneNumber);
        const user = existingUser ?? (await users.create({ phoneNumber }));

        const latestConversation = await conversations.findLatestForUser(user.id);
        const conversation =
          latestConversation ?? (await conversations.create({ userId: user.id }));

        // Meta can deliver the same webhook more than once; save each message only once.
        const existingMessage = await messages.findByWhatsappMessageId(whatsappMessageId);
        const message =
          existingMessage ??
          (await messages.create({
            conversationId: conversation.id,
            whatsappMessageId,
            direction: MessageDirection.INBOUND,
            content,
          }));

        return {
          userId: user.id,
          userCreated: existingUser === null,
          conversationId: conversation.id,
          conversationCreated: latestConversation === null,
          message,
          duplicate: existingMessage !== null,
        };
      },
    );

    // Logged only after the transaction commits, so every log describes saved data.
    const { userId, conversationId, message, duplicate } = saved;
    if (saved.userCreated) {
      this.logger.info({ correlationId, userId }, 'User created');
    } else {
      this.logger.debug({ correlationId, userId }, 'Existing user found');
    }
    if (saved.conversationCreated) {
      this.logger.info({ correlationId, userId, conversationId }, 'Conversation created');
    } else {
      this.logger.debug({ correlationId, userId, conversationId }, 'Latest conversation found');
    }
    const messageContext = {
      correlationId,
      userId,
      conversationId: message.conversationId,
      messageId: message.id,
      whatsappMessageId,
    };
    this.logger.info(
      messageContext,
      duplicate ? 'Inbound message already saved' : 'Inbound message saved',
    );

    return {
      userId,
      conversationId: message.conversationId,
      messageId: message.id,
      duplicate,
    };
  }
}
