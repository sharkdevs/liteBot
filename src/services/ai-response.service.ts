import type { Logger } from 'pino';

import type { IAiProvider } from '../providers/ai/index.js';
import type { IncomingMessageJob } from '../shared/types/incoming-message-job.js';
import type { IConversationService } from './conversation.service.js';

export class AiResponseService {
  constructor(
    private readonly conversationService: IConversationService,
    private readonly aiProvider: IAiProvider,
    private readonly modelName: string,
    private readonly logger: Logger,
  ) {}

  async process(job: IncomingMessageJob): Promise<void> {
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
    );

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
