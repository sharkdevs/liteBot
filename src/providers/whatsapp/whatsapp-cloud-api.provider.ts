import type { WhatsAppSettings } from '../../config/env.js';
import {
  WhatsAppProviderError,
  type IWhatsAppProvider,
  type WhatsAppSendResult,
} from './whatsapp-provider.js';

const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class WhatsAppCloudApiProvider implements IWhatsAppProvider {
  constructor(
    private readonly settings: WhatsAppSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendTextMessage(phoneNumber: string, message: string): Promise<WhatsAppSendResult> {
    if (!/^\+?[1-9][0-9]{6,14}$/.test(phoneNumber)) {
      throw new WhatsAppProviderError('Invalid WhatsApp recipient phone number', false);
    }
    if (!message.trim() || message.length > 4096) {
      throw new WhatsAppProviderError('WhatsApp text must contain 1 to 4096 characters', false);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 10_000);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `https://graph.facebook.com/v26.0/${this.settings.phoneNumberId}/messages`,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${this.settings.accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: phoneNumber,
              type: 'text',
              text: { body: message, preview_url: false },
            }),
            signal: controller.signal,
          },
        );
      } catch {
        throw new WhatsAppProviderError(
          'WhatsApp network request failed or timed out',
          true,
          undefined,
          undefined,
          true,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new WhatsAppProviderError(
          'WhatsApp returned an unreadable response',
          controller.signal.aborted ||
            response.ok ||
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          response.status,
          undefined,
          response.ok,
        );
      }
      if (!response.ok) {
        const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
        const code = typeof error?.code === 'number' ? error.code : undefined;
        const retryable =
          error?.is_transient === true ||
          (code !== undefined && RETRYABLE_CODES.has(code)) ||
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw new WhatsAppProviderError(
          'WhatsApp rejected the message',
          retryable,
          response.status,
          code,
        );
      }
      const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
      const first: unknown = messages[0];
      if (!isRecord(first) || typeof first.id !== 'string' || !first.id.trim()) {
        throw new WhatsAppProviderError(
          'WhatsApp response is missing a message ID',
          true,
          response.status,
          undefined,
          true,
        );
      }
      return { providerResponseId: first.id };
    } finally {
      clearTimeout(timer);
    }
  }
}
