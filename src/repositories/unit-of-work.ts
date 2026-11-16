import type { PrismaClient } from '../generated/prisma/client.js';
import { ConversationRepository, type IConversationRepository } from './conversation.repository.js';
import { MessageRepository, type IMessageRepository } from './message.repository.js';
import { UserRepository, type IUserRepository } from './user.repository.js';

export interface Repositories {
  readonly users: IUserRepository;
  readonly conversations: IConversationRepository;
  readonly messages: IMessageRepository;
}

export interface IUnitOfWork {
  /** Runs work in one transaction without acquiring a sender-specific advisory lock. */
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /**
   * Runs `work` in one database transaction: its changes are saved together, or not at
   * all if it throws. Calls that share a `lockKey` run one at a time.
   */
  runExclusive<T>(lockKey: string, work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export class PrismaUnitOfWork implements IUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) =>
      work({
        users: new UserRepository(tx),
        conversations: new ConversationRepository(tx),
        messages: new MessageRepository(tx),
      }),
    );
  }

  runExclusive<T>(lockKey: string, work: (repositories: Repositories) => Promise<T>): Promise<T> {
    // Interactive transaction: https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions#interactive-transactions
    return this.prisma.$transaction(async (tx) => {
      // A transaction-level advisory lock, released automatically at commit or rollback.
      // https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      return work({
        users: new UserRepository(tx),
        conversations: new ConversationRepository(tx),
        messages: new MessageRepository(tx),
      });
    });
  }
}
