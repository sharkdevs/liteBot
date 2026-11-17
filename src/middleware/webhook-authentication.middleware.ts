import { createHmac, timingSafeEqual } from 'node:crypto';
import { raw, type Request, type RequestHandler } from 'express';

import { BadRequestError } from '../shared/utils/bad-request-error.js';

const authenticatedRequests = new WeakSet<Request>();

export class WebhookAuthenticationError extends Error {
  override readonly name = 'WebhookAuthenticationError';

  constructor() {
    super('Forbidden');
  }
}

export function assertWebhookAuthenticated(req: Request): void {
  if (!authenticatedRequests.has(req)) {
    throw new WebhookAuthenticationError();
  }
}

function readSignature(req: Request): string {
  const signature = req.get('x-hub-signature-256');
  if (
    !signature ||
    signature.length !== 'sha256='.length + 64 ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  ) {
    throw new WebhookAuthenticationError();
  }
  return signature;
}

export function createWebhookAuthenticationMiddleware(appSecret: string): RequestHandler[] {
  if (typeof appSecret !== 'string' || !appSecret.trim()) {
    throw new Error('WHATSAPP_APP_SECRET must be configured with a non-empty value');
  }

  const checkHeaders: RequestHandler = (req, _res, next) => {
    readSignature(req);
    // Inflating before HMAC verification would authenticate different bytes from the delivery.
    const encoding = req.get('content-encoding');
    if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
      throw new WebhookAuthenticationError();
    }
    next();
  };

  const authenticateAndParse: RequestHandler<Request['params'], unknown, unknown> = (
    req,
    _res,
    next,
  ) => {
    if (!Buffer.isBuffer(req.body)) {
      throw new WebhookAuthenticationError();
    }
    const supplied = Buffer.from(readSignature(req).slice('sha256='.length), 'hex');
    const expected = createHmac('sha256', appSecret).update(req.body).digest();
    if (!timingSafeEqual(supplied, expected)) {
      throw new WebhookAuthenticationError();
    }
    authenticatedRequests.add(req);

    if (!req.is('application/json')) {
      throw new BadRequestError();
    }
    try {
      req.body = JSON.parse(req.body.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestError();
    }
    next();
  };

  return [
    checkHeaders,
    raw({ type: () => true, inflate: false, limit: '100kb' }),
    authenticateAndParse,
  ];
}
