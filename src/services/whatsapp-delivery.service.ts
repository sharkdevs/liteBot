import type { Logger } from 'pino';

import {
  WhatsAppProviderError,
  type IWhatsAppProvider,
} from '../providers/whatsapp/whatsapp-provider.js';
import type { DeliveryRepository } from '../repositories/delivery.repository.js';
import {
  DeferredDeliveryError,
  UnknownAcceptanceError,
  type OutgoingMessageJob,
} from '../shared/types/outgoing-message-job.js';

export class WhatsAppDeliveryService {
  constructor(
    private readonly messages: DeliveryRepository,
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
    const claim = await this.messages.claim(job);
    if (claim.state === 'sent') return;
    if (claim.state === 'unknown') throw new UnknownAcceptanceError();
    if (claim.state === 'deferred') throw new DeferredDeliveryError(claim.until);
    let providerResponseId: string;
    try {
      ({ providerResponseId } = await this.provider.sendTextMessage(phoneNumber, saved.content));
    } catch (error) {
      if (error instanceof WhatsAppProviderError && !error.acceptanceUnknown) {
        try {
          await this.messages.markPending(messageId);
        } catch {
          throw new UnknownAcceptanceError();
        }
        throw error;
      }
      throw new UnknownAcceptanceError();
    }
    try {
      await this.messages.markSent(messageId, providerResponseId);
    } catch {
      this.logger.error(
        { ...context, providerResponseId },
        'WhatsApp acceptance could not be persisted',
      );
      throw new UnknownAcceptanceError();
    }
    this.logger.info({ ...context, providerResponseId }, 'WhatsApp message sent');
  }

  async markFailed(job: OutgoingMessageJob): Promise<void> {
    await this.messages.markFailed(job.messageId);
  }
}
