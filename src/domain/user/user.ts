/** A person who writes to the assistant, identified by their WhatsApp phone number. */
export interface User {
  readonly id: string;
  readonly phoneNumber: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewUser = Pick<User, 'phoneNumber'>;
