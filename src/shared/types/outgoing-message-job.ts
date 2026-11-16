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
