import type { DatabaseClient } from '../config/database.js';
import type { NewUser, User } from '../domain/user/user.js';

export interface IUserRepository {
  findByPhoneNumber(phoneNumber: string): Promise<User | null>;
  create(user: NewUser): Promise<User>;
}

export class UserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseClient) {}

  findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { phoneNumber } });
  }

  create(user: NewUser): Promise<User> {
    return this.db.user.create({ data: user });
  }
}
