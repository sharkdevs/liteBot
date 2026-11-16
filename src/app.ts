import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';

import { logger } from './config/logger.js';
import { healthRouter } from './routes/health.route.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.use(healthRouter);

  // TODO(later stages): correlation-id middleware, webhook routes, centralized error middleware.
  // TODO(later stages): enable `cors` with an explicit origin allow-list once a browser client exists.

  return app;
}
