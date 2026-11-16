import { Router } from 'express';

import type { WebhookController } from '../controllers/webhook.controller.js';

export function createWebhookRouter(controller: WebhookController): Router {
  const router = Router();
  router.get('/', controller.verifyWebhook.bind(controller));
  return router;
}
