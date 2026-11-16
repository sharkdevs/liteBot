import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import { WebhookController } from './controllers/webhook.controller.js';
import { createErrorMiddleware } from './middleware/error.middleware.js';
import { assignRequestId, getCorrelationId } from './middleware/request-id.middleware.js';
import { healthRouter } from './routes/health.route.js';
import { createWebhookRouter } from './routes/webhook.route.js';
import type { IncomingMessageQueuePort } from './shared/types/incoming-message-job.js';

interface AppDependencies {
  logger: Logger;
  whatsappVerifyToken: string;
  incomingMessageQueue: IncomingMessageQueuePort;
}

export function createApp({
  logger,
  whatsappVerifyToken,
  incomingMessageQueue,
}: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      genReqId: assignRequestId,
      customProps: (req) => ({ correlationId: getCorrelationId(req) }),
      serializers: {
        req(request: { id?: unknown; method?: string; url?: string }) {
          return { id: request.id, method: request.method, url: request.url?.split('?')[0] };
        },
      },
    }),
  );
  app.use(express.json());

  app.use(healthRouter);
  app.use(
    '/webhook',
    createWebhookRouter(new WebhookController(whatsappVerifyToken, logger, incomingMessageQueue)),
  );
  app.use(createErrorMiddleware(logger));

  // TODO(later stages): authenticate webhook deliveries before enabling real traffic.
  // TODO(later stages): enable `cors` with an explicit origin allow-list once a browser client exists.

  return app;
}
