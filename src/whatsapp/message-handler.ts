/**
 * WhatsApp message event routing for authorized group messages
 */

import type { IWhatsAppClient } from './client.js';
import type { PollService } from '../services/poll-service.js';
import type { WhatsAppMessage, PollVoteResult } from '../types/whatsapp.js';
import { logger } from '../utils/logger.js';

export class MessageHandler {
  constructor(
    private readonly client: IWhatsAppClient,
    private readonly authorizedGroupId: string,
    private readonly pollService: PollService
  ) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.client.onMessage(msg => this.handleMessage(msg));
    this.client.onPollVote((msgId, votes) => this.handlePollVote(msgId, votes));
  }

  private async handleMessage(msg: WhatsAppMessage): Promise<void> {
    if (msg.remoteJid !== this.authorizedGroupId) return;
    if (!msg.text) return;

    logger.debug('Group message received', { msgId: msg.id, from: msg.participant });
  }

  private async handlePollVote(
    messageId: string,
    votes: PollVoteResult[]
  ): Promise<void> {
    logger.debug('Poll vote received', { messageId, voteCount: votes.length });
    await this.pollService.handlePollVote(messageId, votes);
  }
}
