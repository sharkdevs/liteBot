/**
 * Meta gives every message a unique ID, so the same ID arriving from a different sender
 * means the request is forged or corrupted. It is refused rather than saved.
 */
export class WhatsappMessageIdConflictError extends Error {
  override readonly name = 'WhatsappMessageIdConflictError';

  constructor() {
    super('This WhatsApp message ID is already saved for a different sender');
  }
}
