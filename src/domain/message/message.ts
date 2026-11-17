export const MessageDirection = {
  /** Sent by the user to the assistant. */
  INBOUND: 'INBOUND',
  /** Sent by the assistant to the user. */
  OUTBOUND: 'OUTBOUND',
} as const;

export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

export const MessageStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

/** One message in a conversation. */
export interface Message {
  readonly id: string;
  readonly conversationId: string;
  /** Meta's message ID (`wamid...`); `null` until an outbound message has been sent. */
  readonly whatsappMessageId: string | null;
  readonly direction: MessageDirection;
  /** Outbound acceptance state; null for inbound messages. */
  readonly status: MessageStatus | null;
  readonly replyToMessageId: string | null;
  readonly content: string;
  readonly createdAt: Date;
}

export type NewMessage = Pick<
  Message,
  'conversationId' | 'whatsappMessageId' | 'direction' | 'content'
>;
