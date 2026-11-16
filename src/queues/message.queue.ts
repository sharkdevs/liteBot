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
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Add jobs one at a time, in order. BullMQ's node-redis addBulk cannot reload
    // its Lua scripts after a Redis restart, while a single add falls back to EVAL.
    const addInOrder = async () => {
      for (const data of messages) {
        if (timedOut) {
          return;
        }
        // The database message ID doubles as the job ID: adding a job whose ID is already
        // in Redis does nothing, so a redelivered webhook is not queued twice.
        // https://docs.bullmq.io/guide/jobs/job-ids
        const job = await this.queue.add(INCOMING_MESSAGE_JOB_NAME, data, {
          jobId: data.messageId,
        });
        const { correlationId, userId, conversationId, messageId, whatsappMessageId, phoneNumber } =
          data;
        this.logger.info(
          {
            correlationId,
            jobId: job.id,
            userId,
            conversationId,
            messageId,
            whatsappMessageId,
            phoneNumber,
          },
          'Incoming message queued',
        );
      }
    };
    try {
      await Promise.race([
        addInOrder(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Timed out accepting incoming messages'));
          }, QUEUE_ADD_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
