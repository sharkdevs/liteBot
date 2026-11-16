import type { Request, Response } from 'express';
import type { Logger } from 'pino';

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
}
