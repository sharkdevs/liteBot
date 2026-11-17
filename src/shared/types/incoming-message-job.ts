/** What the webhook hands to the worker for one saved inbound text message. */
export interface IncomingMessageJob {
  /** Absent on legacy jobs; only authenticated webhook deliveries set this to true. */
  webhookVerified?: boolean;
  correlationId: string;
  /** Our database ID for the saved message; also used as the BullMQ job ID. */
  messageId: string;
  userId: string;
  conversationId: string;
  /** Meta's message ID (`wamid...`). */
  whatsappMessageId: string;
  phoneNumber: string;
  messageText: string;
  timestamp: string;
}

export interface IncomingMessageQueuePort {
  enqueue(messages: IncomingMessageJob[]): Promise<void>;
}
