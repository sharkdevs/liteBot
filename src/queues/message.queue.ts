import { Queue, type IRedisClient, type QueueOptions } from 'bullmq';
import type { Logger } from 'pino';

import type {
  IncomingMessageJob,
  IncomingMessageQueuePort,
} from '../shared/types/incoming-message-job.js';
import {
  INCOMING_MESSAGE_JOB_NAME,
  INCOMING_MESSAGE_QUEUE_NAME,
  MESSAGE_JOB_ATTEMPTS,
  MESSAGE_JOB_BACKOFF_MS,
  QUEUE_ADD_TIMEOUT_MS,
} from './queue.constants.js';

export class IncomingMessageQueue implements IncomingMessageQueuePort {
  private readonly queue: Queue<IncomingMessageJob, void, typeof INCOMING_MESSAGE_JOB_NAME>;

  constructor(
    private readonly connection: IRedisClient,
    private readonly logger: Logger,
    options: Pick<QueueOptions, 'prefix'> = {},
  ) {
    this.queue = new Queue(INCOMING_MESSAGE_QUEUE_NAME, {
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
      logger.error({ err, queueName: INCOMING_MESSAGE_QUEUE_NAME }, 'Incoming message queue error');
    });
  }

  async enqueue(messages: IncomingMessageJob[]): Promise<void> {
    if (this.connection.status !== 'ready') {
      throw new Error('Incoming message queue Redis connection is not ready');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const jobs = await Promise.race([
        this.queue.addBulk(messages.map((data) => ({ name: INCOMING_MESSAGE_JOB_NAME, data }))),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out accepting incoming messages'));
          }, QUEUE_ADD_TIMEOUT_MS);
        }),
      ]);
      for (const job of jobs) {
        const { correlationId, phoneNumber, messageId } = job.data;
        this.logger.info(
          { correlationId, jobId: job.id, phoneNumber, messageId },
          'Incoming message queued',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
