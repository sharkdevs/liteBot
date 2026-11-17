export interface OutgoingMessageJob {
  readonly phoneNumber: string;
  readonly conversationId: string;
  /** The saved outbound row, not the inbound message that prompted it. */
  readonly messageId: string;
  readonly content: string;
  readonly correlationId: string;
  readonly userId: string;
}

export interface OutgoingMessageQueuePort {
  enqueue(message: OutgoingMessageJob): Promise<void>;
}

export class UnknownAcceptanceError extends Error {
  constructor() {
    super('WhatsApp acceptance is unknown; reconcile before retrying');
    this.name = 'UnknownAcceptanceError';
  }
}

export class DeferredDeliveryError extends Error {
  constructor(readonly until: Date) {
    super('Waiting for earlier recipient work or the recipient send interval');
    this.name = 'DeferredDeliveryError';
  }
}

export class InvalidDispatchError extends Error {}
