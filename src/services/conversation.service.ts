import type { Logger } from 'pino';

import { WhatsappMessageIdConflictError } from '../domain/message/message-id-conflict.error.js';
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

        // Meta can deliver the same webhook more than once; a redelivery saves nothing new.
        const existingMessage = await messages.findByWhatsappMessageId(whatsappMessageId);
        if (existingMessage) {
          const owner = await conversations.findById(existingMessage.conversationId);
          if (existingUser === null || owner?.userId !== existingUser.id) {
            throw new WhatsappMessageIdConflictError();
          }
          return { userId: existingUser.id, message: existingMessage, duplicate: true } as const;
        }

        const user = existingUser ?? (await users.create({ phoneNumber }));
        const latestConversation = await conversations.findLatestForUser(user.id);
        const conversation =
          latestConversation ?? (await conversations.create({ userId: user.id }));
        const message = await messages.create({
          conversationId: conversation.id,
          whatsappMessageId,
          direction: MessageDirection.INBOUND,
          content,
        });

        return {
          userId: user.id,
          userCreated: existingUser === null,
          conversationCreated: latestConversation === null,
          message,
          duplicate: false,
        } as const;
      },
    );

    // Logged only after the transaction commits, so every log describes saved data.
    const { userId, message } = saved;
    const conversationId = message.conversationId;
    const messageContext = {
      correlationId,
      userId,
      conversationId,
      messageId: message.id,
      whatsappMessageId,
    };
    if (saved.duplicate) {
      this.logger.info(messageContext, 'Inbound message already saved');
    } else {
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
      this.logger.info(messageContext, 'Inbound message saved');
    }

    return { userId, conversationId, messageId: message.id, duplicate: saved.duplicate };
  }
}
