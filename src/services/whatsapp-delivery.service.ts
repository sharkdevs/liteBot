import type { Logger } from 'pino';

import {
  WhatsAppProviderError,
  type IWhatsAppProvider,
} from '../providers/whatsapp/whatsapp-provider.js';
import type { IMessageRepository } from '../repositories/message.repository.js';
import type { OutgoingMessageJob } from '../shared/types/outgoing-message-job.js';

export class WhatsAppDeliveryService {
  constructor(
    private readonly messages: Pick<IMessageRepository, 'findById' | 'markSent' | 'markFailed'>,
    private readonly provider: IWhatsAppProvider,
    private readonly logger: Logger,
  ) {}

  async send(job: OutgoingMessageJob): Promise<void> {
    const saved = await this.messages.findById(job.messageId);
    if (
      !saved ||
      saved.direction !== 'OUTBOUND' ||
      saved.conversationId !== job.conversationId ||
      saved.content !== job.content
    ) {
      throw new WhatsAppProviderError(
        'Outgoing job does not match a saved outbound message',
        false,
      );
    }
    const { phoneNumber, messageId, conversationId, correlationId, userId } = job;
    const context = { phoneNumber, messageId, conversationId, correlationId, userId };
    if (saved.status === 'SENT') {
      this.logger.info(
        { ...context, providerResponseId: saved.whatsappMessageId },
        'WhatsApp message already sent',
      );
      return;
    }
    const { providerResponseId } = await this.provider.sendTextMessage(phoneNumber, saved.content);
    try {
      await this.messages.markSent(messageId, providerResponseId);
    } catch {
      this.logger.error(
        { ...context, providerResponseId },
        'WhatsApp acceptance could not be persisted',
      );
      throw new Error('WhatsApp acceptance could not be persisted');
    }
    this.logger.info({ ...context, providerResponseId }, 'WhatsApp message sent');
  }

  async markFailed(job: OutgoingMessageJob): Promise<void> {
    await this.messages.markFailed(job.messageId);
  }
}
