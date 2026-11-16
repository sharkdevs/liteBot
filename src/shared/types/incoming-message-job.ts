export interface IncomingMessageJob {
  phoneNumber: string;
  messageId: string;
  messageText: string;
  timestamp: string;
  correlationId: string;
}

export interface IncomingMessageQueuePort {
  enqueue(messages: IncomingMessageJob[]): Promise<void>;
}
