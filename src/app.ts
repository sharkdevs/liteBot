import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import { WebhookController } from './controllers/webhook.controller.js';
import { healthRouter } from './routes/health.route.js';
import { createWebhookRouter } from './routes/webhook.route.js';

interface AppDependencies {
  logger: Logger;
  whatsappVerifyToken: string;
}

export function createApp({ logger, whatsappVerifyToken }: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(request: { id?: unknown; method?: string; url?: string }) {
          return { id: request.id, method: request.method, url: request.url?.split('?')[0] };
        },
      },
    }),
  );
  app.use(express.json());

  app.use(healthRouter);
  app.use('/webhook', createWebhookRouter(new WebhookController(whatsappVerifyToken, logger)));

  // TODO(later stages): correlation-id middleware and authenticated webhook delivery.
  // TODO(later stages): enable `cors` with an explicit origin allow-list once a browser client exists.

  return app;
}
