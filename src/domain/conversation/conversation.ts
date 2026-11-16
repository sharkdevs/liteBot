/** A thread of messages between one user and the assistant. A user can have many. */
export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewConversation = Pick<Conversation, 'userId'>;
