export const MessageDirection = {
  /** Sent by the user to the assistant. */
  INBOUND: 'INBOUND',
  /** Sent by the assistant to the user. */
  OUTBOUND: 'OUTBOUND',
} as const;

export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

/** One message in a conversation. */
export interface Message {
  readonly id: string;
  readonly conversationId: string;
  /** Meta's message ID (`wamid...`); `null` until an outbound message has been sent. */
  readonly whatsappMessageId: string | null;
  readonly direction: MessageDirection;
  readonly content: string;
  readonly createdAt: Date;
}

export type NewMessage = Pick<
  Message,
  'conversationId' | 'whatsappMessageId' | 'direction' | 'content'
>;
