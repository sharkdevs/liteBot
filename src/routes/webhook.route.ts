import { Router } from 'express';

import type { WebhookController } from '../controllers/webhook.controller.js';
import { createWebhookAuthenticationMiddleware } from '../middleware/webhook-authentication.middleware.js';

export function createWebhookRouter(
  controller: WebhookController,
  whatsappAppSecret: string,
): Router {
  const router = Router();
  router.get('/', controller.verifyWebhook.bind(controller));
  router.post(
    '/',
    ...createWebhookAuthenticationMiddleware(whatsappAppSecret),
    controller.handleIncomingWebhook.bind(controller),
  );
  return router;
}
