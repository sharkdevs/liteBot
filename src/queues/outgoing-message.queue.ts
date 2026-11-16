import { Queue, type IRedisClient, type QueueOptions } from 'bullmq';
import type { Logger } from 'pino';

import type {
  OutgoingMessageJob,
  OutgoingMessageQueuePort,
} from '../shared/types/outgoing-message-job.js';
import {
  OUTGOING_MESSAGE_JOB_NAME,
  OUTGOING_MESSAGE_QUEUE_NAME,
  MESSAGE_JOB_ATTEMPTS,
  MESSAGE_JOB_BACKOFF_MS,
  QUEUE_ADD_TIMEOUT_MS,
} from './queue.constants.js';

export class OutgoingMessageQueue implements OutgoingMessageQueuePort {
  private readonly queue: Queue<OutgoingMessageJob, void, typeof OUTGOING_MESSAGE_JOB_NAME>;

  constructor(
    private readonly connection: IRedisClient,
    private readonly logger: Logger,
    options: Pick<QueueOptions, 'prefix'> = {},
  ) {
    this.queue = new Queue(OUTGOING_MESSAGE_QUEUE_NAME, {
      ...options,
      connection,
      defaultJobOptions: {
        attempts: MESSAGE_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: MESSAGE_JOB_BACKOFF_MS },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
    this.queue.on('error', (err: Error) => {
      logger.error({ err, queueName: OUTGOING_MESSAGE_QUEUE_NAME }, 'Outgoing message queue error');
    });
  }

  async enqueue(data: OutgoingMessageJob): Promise<void> {
    if (this.connection.status !== 'ready') {
      throw new Error('Outgoing message queue Redis connection is not ready');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Single add retains node-redis's NOSCRIPT recovery; the saved reply ID deduplicates retries.
      const job = await Promise.race([
        this.queue.add(OUTGOING_MESSAGE_JOB_NAME, data, { jobId: data.messageId }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out accepting outgoing message'));
          }, QUEUE_ADD_TIMEOUT_MS);
        }),
      ]);
      const { correlationId, userId, conversationId, messageId, phoneNumber } = data;
      this.logger.info(
        { correlationId, userId, conversationId, messageId, phoneNumber, jobId: job.id },
        'Outgoing message queued',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
