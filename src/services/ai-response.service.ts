import type { Logger } from 'pino';

import type { IAiProvider } from '../providers/ai/index.js';
import type { IncomingMessageJob } from '../shared/types/incoming-message-job.js';
import type { OutgoingMessageQueuePort } from '../shared/types/outgoing-message-job.js';
import type { IAiConversationService } from './conversation.service.js';

export class AiResponseService {
  constructor(
    private readonly conversationService: IAiConversationService,
    private readonly aiProvider: IAiProvider,
    private readonly modelName: string,
    private readonly logger: Logger,
    private readonly outgoingQueue: OutgoingMessageQueuePort,
  ) {}

  async process(job: IncomingMessageJob): Promise<void> {
    if (job.webhookVerified !== true) {
      throw new Error('Refusing work without authenticated webhook provenance');
    }
    const existing = await this.conversationService.findReplyToMessage(job.messageId);
    if (existing) {
      if (existing.status === 'PENDING') {
        await this.outgoingQueue.enqueue({
          phoneNumber: job.phoneNumber,
          conversationId: job.conversationId,
          messageId: existing.id,
          content: existing.content,
          correlationId: job.correlationId,
          userId: job.userId,
        });
      }
      this.logger.info(
        {
          correlationId: job.correlationId,
          messageId: job.messageId,
          responseMessageId: existing.id,
          status: existing.status,
        },
        'Saved AI response reused',
      );
      return;
    }
    const history = await this.conversationService.getRecentMessages(
      job.conversationId,
      20,
      job.messageId,
    );
    const context = {
      correlationId: job.correlationId,
      userId: job.userId,
      conversationId: job.conversationId,
      messageId: job.messageId,
      modelName: this.modelName,
    };
    const startedAt = Date.now();
    this.logger.info(context, 'AI response generation started');
    const response = await this.aiProvider.generateResponse(job.messageText, history);
    const savedResponse = await this.conversationService.saveOutboundMessage(
      job.conversationId,
      response,
      job.messageId,
      job.correlationId,
    );
    await this.outgoingQueue.enqueue({
      phoneNumber: job.phoneNumber,
      conversationId: job.conversationId,
      messageId: savedResponse.id,
      content: savedResponse.content,
      correlationId: job.correlationId,
      userId: job.userId,
    });

    this.logger.info(
      {
        ...context,
        responseMessageId: savedResponse.id,
        responseLength: response.length,
        durationMs: Date.now() - startedAt,
      },
      'AI response generated and saved',
    );
  }
}
