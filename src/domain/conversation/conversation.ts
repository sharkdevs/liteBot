/**
 * What Meta reports about a WhatsApp conversation. Each field is `null` until a webhook
 * supplies it: inbound messages carry none of it, and Meta sends it only in some status
 * updates for messages the business sends.
 */
export interface WhatsappConversationMetadata {
  /** Meta's `conversation.id`. */
  readonly whatsappConversationId: string | null;
  /** Meta's `pricing.category`, kept as Meta's raw string (for example `service`). */
  readonly category: string | null;
  /** Meta's `conversation.origin.type`, kept as Meta's raw string (for example `service`). */
  readonly originType: string | null;
  /** Meta's `conversation.expiration_timestamp`. */
  readonly expiresAt: Date | null;
}

/**
 * A WhatsApp conversation between one user and the business, as far as we have observed it.
 * It is not an application-defined session: nothing here opens a new one after a period of
 * inactivity. A user can have many.
 */
export interface Conversation extends WhatsappConversationMetadata {
  readonly id: string;
  readonly userId: string;
  /** The WhatsApp timestamp of the first message stored in the conversation. */
  readonly startedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewConversation = Pick<Conversation, 'userId' | 'startedAt'> &
  Partial<WhatsappConversationMetadata>;
