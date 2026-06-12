/**
 * WhatsApp poll gateway — formats and sends availability polls
 */

import type { IWhatsAppClient } from './client.js';
import type { Game } from '../types/entities.js';

const POLL_OPTIONS = ['Yes', 'No', 'Maybe'];

export class PollManager {
  constructor(private readonly client: IWhatsAppClient) {}

  formatPollQuestion(game: Game): string {
    const dateStr = game.gameDate.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    return `Available vs ${game.opponent} (${dateStr})?`;
  }

  getPollOptions(): string[] {
    return [...POLL_OPTIONS];
  }

  async sendPoll(game: Game, groupJid: string): Promise<string> {
    return this.client.sendPoll(groupJid, {
      name: this.formatPollQuestion(game),
      values: this.getPollOptions(),
      selectableCount: 1,
    });
  }
}
