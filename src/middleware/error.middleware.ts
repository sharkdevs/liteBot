import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

import { BadRequestError } from '../shared/utils/bad-request-error.js';

function isBodyParserError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function createErrorMiddleware(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof BadRequestError || isBodyParserError(error)) {
      logger.warn({ eventType: 'request_rejected' }, 'Malformed request');
      res.status(400).json({ error: 'Malformed request' });
      return;
    }

    logger.error({ err: error, eventType: 'request_failed' }, 'Unexpected request error');
    res.status(500).json({ error: 'Internal server error' });
  };
}
