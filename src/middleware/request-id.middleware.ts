import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function assignRequestId(req: IncomingMessage, res: ServerResponse): string {
  const supplied = req.headers['x-correlation-id'];
  const correlationId =
    typeof supplied === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(supplied)
      ? supplied
      : randomUUID();
  res.setHeader('x-correlation-id', correlationId);
  return correlationId;
}

export function getCorrelationId(req: IncomingMessage): string {
  if (typeof req.id !== 'string') {
    throw new Error('Request correlation ID was not initialized');
  }
  return req.id;
}
