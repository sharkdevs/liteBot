export interface WhatsAppSendResult {
  readonly providerResponseId: string;
}

export interface IWhatsAppProvider {
  /** Resolves when the provider accepts the message, not when the recipient receives it. */
  sendTextMessage(phoneNumber: string, message: string): Promise<WhatsAppSendResult>;
}

/** Contains only safe diagnostics, never the provider body, headers, or original error. */
export class WhatsAppProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly apiCode?: number,
    readonly acceptanceUnknown = false,
  ) {
    super(message);
    this.name = 'WhatsAppProviderError';
  }
}
