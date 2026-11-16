import type { Request, Response } from 'express';
import type { Logger } from 'pino';

import { parseWebhookPayload } from '../shared/utils/webhook-validation.js';

export class WebhookController {
  constructor(
    private readonly verifyToken: string,
    private readonly logger: Logger,
  ) {}

  verifyWebhook(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode !== 'subscribe' || typeof token !== 'string' || !token || token !== this.verifyToken) {
      this.logger.warn(
        { eventType: 'webhook_verification_rejected' },
        'Webhook verification rejected',
      );
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (typeof challenge !== 'string' || challenge.trim().length === 0) {
      this.logger.warn({ eventType: 'webhook_verification_invalid' }, 'Invalid webhook challenge');
      res.status(400).json({ error: 'Invalid verification challenge' });
      return;
    }

    this.logger.info({ eventType: 'webhook_verified' }, 'Webhook verification succeeded');
    res.status(200).type('text/plain').send(challenge);
  }

  handleIncomingWebhook(
    req: Request<Record<string, string>, unknown, unknown>,
    res: Response,
  ): void {
    const payload = parseWebhookPayload(req.body);
    this.logger.info({ payload }, 'WhatsApp webhook payload received');

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        const messages = change.value.messages;
        if (!messages?.length) {
          this.logger.info({ eventType: change.field }, 'WhatsApp webhook event received');
          continue;
        }
        for (const message of messages) {
          this.logger.info(
            { eventType: change.field, phoneNumber: message.from, messageId: message.id },
            'WhatsApp webhook event received',
          );
        }
      }
    }

    res.sendStatus(200);
  }
}
