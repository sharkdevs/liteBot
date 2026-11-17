import {
  Worker,
  UnrecoverableError,
  DelayedError,
  type IRedisClient,
  type Job,
  type WorkerOptions,
} from 'bullmq';
import type { Logger } from 'pino';

import { WhatsAppProviderError } from '../providers/whatsapp/whatsapp-provider.js';
import {
  OUTGOING_MESSAGE_JOB_NAME,
  OUTGOING_MESSAGE_QUEUE_NAME,
} from '../queues/queue.constants.js';
import type { WhatsAppDeliveryService } from '../services/whatsapp-delivery.service.js';
import {
  DeferredDeliveryError,
  UnknownAcceptanceError,
  InvalidDispatchError,
  type OutgoingMessageJob,
} from '../shared/types/outgoing-message-job.js';

type OutgoingJob = Job<OutgoingMessageJob, void, typeof OUTGOING_MESSAGE_JOB_NAME>;

function logContext(job: OutgoingJob) {
  const { correlationId, userId, phoneNumber, conversationId, messageId } = job.data;
  return { correlationId, userId, phoneNumber, conversationId, messageId, jobId: job.id };
}

export function createWhatsAppWorker(
  connection: IRedisClient,
  logger: Logger,
  delivery: Pick<WhatsAppDeliveryService, 'send' | 'markFailed'>,
  options: Pick<WorkerOptions, 'prefix'> = {},
): Worker<OutgoingMessageJob, void, typeof OUTGOING_MESSAGE_JOB_NAME> {
  const worker = new Worker<OutgoingMessageJob, void, typeof OUTGOING_MESSAGE_JOB_NAME>(
    OUTGOING_MESSAGE_QUEUE_NAME,
    async (job, token) => {
      const attempt = job.attemptsMade + 1;
      const context = { ...logContext(job), attempt };
      logger.info(context, 'Outgoing message processing started');
      try {
        await delivery.send(job.data);
      } catch (error) {
        if (error instanceof DeferredDeliveryError) {
          await job.moveToDelayed(error.until.getTime(), token);
          logger.info(context, 'Outgoing message deferred for recipient ordering or pacing');
          throw new DelayedError();
        }
        if (error instanceof UnknownAcceptanceError) {
          logger.error(context, 'Outgoing acceptance unknown; operator reconciliation required');
          throw new UnrecoverableError(error.message);
        }
        const providerError = error instanceof WhatsAppProviderError ? error : undefined;
        const permanent =
          error instanceof InvalidDispatchError || providerError?.retryable === false;
        const terminal = permanent || attempt >= (job.opts.attempts ?? 1);
        logger.error(
          {
            ...context,
            terminal,
            retryable: !permanent,
            httpStatus: providerError?.httpStatus,
            apiCode: providerError?.apiCode,
          },
          'Outgoing message attempt failed',
        );
        if (terminal) {
          // Await persistence inside the processor, not an unawaited failed-event listener.
          try {
            await delivery.markFailed(job.data);
          } catch {
            logger.error(context, 'Outgoing message FAILED status could not be persisted');
            throw new UnrecoverableError('Outgoing message failure status persistence failed');
          }
        }
        if (permanent) {
          throw new UnrecoverableError('Permanent WhatsApp send failure');
        }
        // eslint-disable-next-line preserve-caught-error -- Raw errors can contain credentials or message text.
        throw new Error('Outgoing message processing failed');
      }
    },
    { ...options, connection },
  );
  worker.on('ready', () => {
    logger.info({ queueName: OUTGOING_MESSAGE_QUEUE_NAME }, 'WhatsApp worker ready');
  });
  worker.on('completed', (job) => {
    logger.info(logContext(job), 'Outgoing message processing completed');
  });
  worker.on('failed', (job) => {
    logger.error(
      { ...(job ? logContext(job) : {}), attemptsMade: job?.attemptsMade },
      'Outgoing message job failed',
    );
  });
  worker.on('error', () => {
    logger.error({ queueName: OUTGOING_MESSAGE_QUEUE_NAME }, 'WhatsApp worker error');
  });
  return worker;
}
