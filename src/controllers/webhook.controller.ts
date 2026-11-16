import type { Request, Response } from 'express';
import type { Logger } from 'pino';

import { getCorrelationId } from '../middleware/request-id.middleware.js';
import type {
  IncomingMessageJob,
  IncomingMessageQueuePort,
} from '../shared/types/incoming-message-job.js';
import { parseWebhookPayload } from '../shared/utils/webhook-validation.js';

export class WebhookController {
  constructor(
    private readonly verifyToken: string,
    private readonly logger: Logger,
    private readonly incomingMessageQueue: IncomingMessageQueuePort,
  ) {}

  verifyWebhook(req: Request, res: Response): void {
    const correlationId = getCorrelationId(req);
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode !== 'subscribe' || typeof token !== 'string' || !token || token !== this.verifyToken) {
      this.logger.warn(
        { correlationId, eventType: 'webhook_verification_rejected' },
        'Webhook verification rejected',
      );
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (typeof challenge !== 'string' || challenge.trim().length === 0) {
      this.logger.warn(
        { correlationId, eventType: 'webhook_verification_invalid' },
        'Invalid webhook challenge',
      );
      res.status(400).json({ error: 'Invalid verification challenge' });
      return;
    }

    this.logger.info(
      { correlationId, eventType: 'webhook_verified' },
      'Webhook verification succeeded',
    );
    res.status(200).type('text/plain').send(challenge);
  }

  async handleIncomingWebhook(
    req: Request<Record<string, string>, unknown, unknown>,
    res: Response,
  ): Promise<void> {
    const payload = parseWebhookPayload(req.body);
    const correlationId = getCorrelationId(req);
    this.logger.info(
      { correlationId, eventType: 'webhook_received', entryCount: payload.entry.length },
      'WhatsApp webhook payload received',
    );
    const jobs: IncomingMessageJob[] = [];

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        const messages = change.value.messages;
        if (!messages?.length) {
          this.logger.info(
            { correlationId, eventType: change.field },
            'WhatsApp webhook event received',
          );
          continue;
        }
        for (const message of messages) {
          const context = {
            correlationId,
            eventType: change.field,
            phoneNumber: message.from,
            messageId: message.id,
          };
          this.logger.info(context, 'WhatsApp webhook event received');
          if (
            change.field === 'messages' &&
            message.type === 'text' &&
            message.from &&
            message.text &&
            message.timestamp
          ) {
            jobs.push({
              correlationId,
              phoneNumber: message.from,
              messageId: message.id,
              messageText: message.text.body,
              timestamp: message.timestamp,
            });
          } else {
            const reason =
              change.field !== 'messages'
                ? 'unsupported_event'
                : !message.from
                  ? 'missing_phone_number'
                  : 'unsupported_message_type';
            this.logger.warn({ ...context, reason }, 'Webhook message not queued');
          }
        }
      }
    }

    if (jobs.length > 0) {
      await this.incomingMessageQueue.enqueue(jobs);
    }
    res.sendStatus(200);
  }
}
