import type { PrismaClient } from '../generated/prisma/client.js';
import type { Message } from '../domain/message/message.js';
import {
  InvalidDispatchError,
  type OutgoingMessageJob,
} from '../shared/types/outgoing-message-job.js';
import { MessageRepository } from './message.repository.js';

export type DeliveryClaim =
  | { readonly state: 'claimed' | 'sent' | 'unknown' }
  | { readonly state: 'deferred'; readonly until: Date };

export interface DeliveryRepository {
  findById(id: string): Promise<Message | null>;
  claim(job: OutgoingMessageJob): Promise<DeliveryClaim>;
  markPending(id: string): Promise<void>;
  markSent(id: string, receipt: string): Promise<void>;
  markFailed(id: string): Promise<void>;
}

export const RECIPIENT_SEND_INTERVAL_MS = 6000;

export class PrismaDeliveryRepository extends MessageRepository implements DeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {
    super(prisma);
  }

  async claim(job: OutgoingMessageJob): Promise<DeliveryClaim> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`whatsapp-send:${job.userId}`}, 0))
      `;
      const saved = await tx.message.findUnique({
        where: { id: job.messageId },
        include: { conversation: { include: { user: true } } },
      });
      if (
        !saved ||
        saved.direction !== 'OUTBOUND' ||
        saved.conversationId !== job.conversationId ||
        saved.content !== job.content ||
        saved.conversation.userId !== job.userId ||
        saved.conversation.user.phoneNumber !== job.phoneNumber ||
        saved.dispatchCorrelationId === null
      ) {
        throw new InvalidDispatchError(
          'Outgoing work lacks matching authenticated dispatch intent',
        );
      }
      if (saved.status === 'SENT') return { state: 'sent' };
      if (saved.status === 'UNKNOWN') return { state: 'unknown' };
      if (saved.status !== 'PENDING') {
        throw new InvalidDispatchError('Only pending dispatches may be sent');
      }
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Database clock unavailable');
      const now = clock.now;
      const oldest = await tx.message.findFirst({
        where: {
          conversation: { userId: job.userId },
          direction: 'OUTBOUND',
          dispatchCorrelationId: { not: null },
          status: { in: ['PENDING', 'UNKNOWN'] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      const next = saved.conversation.user.nextWhatsappSendAt;
      if (oldest?.id !== saved.id || (next !== null && next > now)) {
        return {
          state: 'deferred',
          until:
            next !== null && next > now
              ? next
              : new Date(now.getTime() + RECIPIENT_SEND_INTERVAL_MS),
        };
      }
      await tx.user.update({
        where: { id: job.userId },
        data: { nextWhatsappSendAt: new Date(now.getTime() + RECIPIENT_SEND_INTERVAL_MS) },
      });
      // Commit uncertainty before crossing the HTTP boundary, including the crash-before-call case.
      await tx.message.update({ where: { id: saved.id }, data: { status: 'UNKNOWN' } });
      return { state: 'claimed' };
    });
  }

  async markPending(id: string): Promise<void> {
    await this.prisma.message.update({
      where: { id, direction: 'OUTBOUND', status: 'UNKNOWN' },
      data: { status: 'PENDING' },
    });
  }

  async reconcileUnknown(id: string, receipt: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.findUniqueOrThrow({
        where: {
          id,
          direction: 'OUTBOUND',
          status: 'UNKNOWN',
          dispatchCorrelationId: { not: null },
        },
        include: { conversation: true },
      });
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`whatsapp-send:${message.conversation.userId}`}, 0))
      `;
      await tx.message.update({
        where: { id, status: 'UNKNOWN' },
        data:
          receipt === null ? { status: 'PENDING' } : { status: 'SENT', whatsappMessageId: receipt },
      });
    });
  }
}
