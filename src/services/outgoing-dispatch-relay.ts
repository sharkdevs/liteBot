import type { Logger } from 'pino';
import type { IMessageRepository } from '../repositories/message.repository.js';
import type { OutgoingMessageQueuePort } from '../shared/types/outgoing-message-job.js';

export class OutgoingDispatchRelay {
  private cursor: string | undefined;

  constructor(
    private readonly messages: Pick<IMessageRepository, 'findPendingDispatches'>,
    private readonly queue: OutgoingMessageQueuePort,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    const page = await this.messages.findPendingDispatches(this.cursor);
    for (const job of page) {
      await this.queue.enqueue(job);
      this.cursor = job.messageId;
    }
    if (page.length < 100) this.cursor = undefined;
  }

  start(): () => Promise<void> {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void>;
    const tick = async () => {
      try {
        await this.runOnce();
      } catch {
        this.logger.error('Outgoing dispatch recovery failed; will retry');
      } finally {
        if (!stopped) {
          timer = setTimeout(() => {
            active = tick();
          }, 10_000);
          timer.unref();
        }
      }
    };
    active = tick();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await active;
    };
  }
}
