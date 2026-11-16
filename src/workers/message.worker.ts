import { Worker, type IRedisClient, type Job, type WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';

import {
  INCOMING_MESSAGE_JOB_NAME,
  INCOMING_MESSAGE_QUEUE_NAME,
} from '../queues/queue.constants.js';
import type { IncomingMessageJob } from '../shared/types/incoming-message-job.js';

type MessageJob = Job<IncomingMessageJob, void, typeof INCOMING_MESSAGE_JOB_NAME>;

function logContext(job: MessageJob) {
  const { correlationId, phoneNumber, messageId } = job.data;
  return { correlationId, jobId: job.id, phoneNumber, messageId };
}

export function createMessageWorker(
  connection: IRedisClient,
  logger: Logger,
  options: Pick<WorkerOptions, 'prefix'> = {},
): Worker<IncomingMessageJob, void, typeof INCOMING_MESSAGE_JOB_NAME> {
  const worker = new Worker<IncomingMessageJob, void, typeof INCOMING_MESSAGE_JOB_NAME>(
    INCOMING_MESSAGE_QUEUE_NAME,
    (job) => {
      const context = { ...logContext(job), attempt: job.attemptsMade + 1 };
      if (job.attemptsMade > 0) {
        logger.warn(context, 'Retrying incoming message');
      }
      logger.info(context, 'Incoming message processing started');
      logger.info(
        { ...context, payload: { ...job.data, messageText: '[Redacted]' } },
        'Incoming message payload received',
      );
      return Promise.resolve();
    },
    { ...options, connection },
  );
  worker.on('ready', () => {
    logger.info({ queueName: INCOMING_MESSAGE_QUEUE_NAME }, 'Incoming message worker ready');
  });
  worker.on('completed', (job) => {
    logger.info(logContext(job), 'Incoming message processing completed');
  });
  worker.on('failed', (job, err) => {
    logger.error(
      { ...(job ? logContext(job) : {}), err, attemptsMade: job?.attemptsMade },
      'Incoming message job failed',
    );
  });
  worker.on('error', (err) => {
    logger.error({ err, queueName: INCOMING_MESSAGE_QUEUE_NAME }, 'Incoming message worker error');
  });
  return worker;
}
