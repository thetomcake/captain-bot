/**
 * Poll service — orchestrates poll creation, posting, and response tracking
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import type { IWhatsAppClient } from '../whatsapp/client.js';
import { PollManager } from '../whatsapp/poll-manager.js';
import type { FixtureService } from './fixture-service.js';
import type { PollVoteResult } from '../types/whatsapp.js';
import type { Game, Poll } from '../types/entities.js';
import { logger } from '../utils/logger.js';

export interface PostPollOptions {
  force?: boolean;
}

export class PollService {
  private readonly pollManager: PollManager;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly fixtureService: FixtureService,
    private readonly client: IWhatsAppClient,
    private readonly groupJid: string
  ) {
    this.pollManager = new PollManager(client);
  }

  /**
   * Post poll for a specific game; returns message ID or null if skipped/not found.
   *
   * On the create path (no existing poll, or `--force`) this hard-deletes any
   * existing poll for the game before storing the new one, so a game never has
   * more than one poll row (FR-024). Ordering is deliberate:
   *   1. sendPoll()              — a send failure aborts before any DB mutation
   *   2. removeExistingPollForGame() — cascade-delete old responses + poll row,
   *                                    best-effort delete the old WhatsApp message
   *   3. storePoll()             — delete-before-insert keeps the unique(gameId)
   *                                constraint (T064g) satisfied
   */
  async postPollForGame(
    gameId: number,
    options: PostPollOptions = {}
  ): Promise<string | null> {
    const game = await this.fixtureService.getGame(gameId);
    if (!game) return null;

    const existing = await this.getPoll(gameId);
    if (!options.force && existing) {
      return null;
    }

    const messageId = await this.pollManager.sendPoll(game, this.groupJid);

    if (existing) {
      await this.removeExistingPollForGame(game);
    }

    await this.storePoll(game, messageId);
    return messageId;
  }

  /**
   * Post poll for the next upcoming game for a team
   */
  async postPollForNextGame(
    teamId: number,
    options: PostPollOptions = {}
  ): Promise<string | null> {
    const game = await this.getNextGame(teamId);
    if (!game) return null;
    return this.postPollForGame(game.id, options);
  }

  /**
   * Find the next upcoming game for a team
   */
  async getNextGame(teamId: number): Promise<Game | null> {
    const season = await this.getTeamCurrentSeason(teamId);
    if (!season) return null;

    const upcoming = await this.fixtureService.getUpcomingFixtures(season.id);
    return upcoming[0] ?? null;
  }

  /**
   * Check if a poll has been posted for the given game
   */
  async hasPollForGame(gameId: number): Promise<boolean> {
    const poll = await this.getPoll(gameId);
    return poll !== null;
  }

  /**
   * Get the poll for a game, or null if none.
   *
   * The unique(gameId) constraint (T064g) guarantees at most one row; the
   * `postedAt DESC` ordering is defence-in-depth so the most recent poll always
   * wins even if a stray duplicate ever slips past the constraint.
   */
  async getPoll(gameId: number): Promise<Poll | null> {
    const [poll] = await this.db
      .select()
      .from(schema.polls)
      .where(eq(schema.polls.gameId, gameId))
      .orderBy(desc(schema.polls.postedAt))
      .limit(1);

    return poll ?? null;
  }

  /**
   * Process incoming poll vote events from WhatsApp
   */
  async handlePollVote(messageId: string, votes: PollVoteResult[]): Promise<void> {
    const [poll] = await this.db
      .select()
      .from(schema.polls)
      .where(eq(schema.polls.whatsappMessageId, messageId))
      .limit(1);

    if (!poll) return;

    for (const vote of votes) {
      for (const voterJid of vote.voters) {
        await this.upsertPollResponse(poll.id, voterJid, vote.optionName);
      }
    }
  }

  /**
   * Record a poll response; upserts so a voter can change their answer
   */
  async recordPollResponse(
    pollId: number,
    userJid: string,
    selectedOption: string
  ): Promise<void> {
    const messageId = await this.getMessageIdForPoll(pollId);
    await this.handlePollVote(messageId, [
      { optionName: selectedOption, voters: [userJid], voteCount: 1 },
    ]);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Remove the existing poll for a game (FR-024 replacement): cascade-delete its
   * responses, then the poll row, then best-effort delete the old WhatsApp
   * message. A WhatsApp delete failure is logged and swallowed so the
   * replacement always completes.
   */
  private async removeExistingPollForGame(game: Game): Promise<void> {
    const existing = await this.getPoll(game.id);
    if (!existing) return;

    // Cascade: responses reference the poll, so they must go first.
    await this.db
      .delete(schema.pollResponses)
      .where(eq(schema.pollResponses.pollId, existing.id));

    await this.db.delete(schema.polls).where(eq(schema.polls.id, existing.id));

    // Best-effort: removing the WhatsApp message is not allowed to fail the
    // replacement (FR-024). The logger timestamps every line.
    try {
      await this.client.deleteMessage(this.groupJid, existing.whatsappMessageId);
    } catch (error) {
      logger.warn('Failed to delete old WhatsApp poll message during replacement', {
        gameId: game.id,
        whatsappMessageId: existing.whatsappMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async storePoll(game: Game, messageId: string): Promise<void> {
    await this.db.insert(schema.polls).values({
      gameId: game.id,
      whatsappMessageId: messageId,
      postedAt: new Date(),
      pollQuestion: this.pollManager.formatPollQuestion(game),
      pollOptions: this.pollManager.getPollOptions(),
    });
  }

  private async upsertPollResponse(
    pollId: number,
    userJid: string,
    option: string
  ): Promise<void> {
    const user = await this.getOrCreateUser(userJid);

    const allResponses = await this.db
      .select()
      .from(schema.pollResponses)
      .where(eq(schema.pollResponses.pollId, pollId));

    const userResponse = allResponses.find(r => r.userId === user.id);

    if (userResponse) {
      await this.db
        .update(schema.pollResponses)
        .set({ selectedOption: option, respondedAt: new Date() })
        .where(eq(schema.pollResponses.id, userResponse.id));
    } else {
      await this.db.insert(schema.pollResponses).values({
        pollId,
        userId: user.id,
        selectedOption: option,
        respondedAt: new Date(),
      });
    }
  }

  private async getOrCreateUser(
    whatsappId: string
  ): Promise<typeof schema.whatsappUsers.$inferSelect> {
    const [existing] = await this.db
      .select()
      .from(schema.whatsappUsers)
      .where(eq(schema.whatsappUsers.whatsappId, whatsappId))
      .limit(1);

    if (existing) {
      await this.db
        .update(schema.whatsappUsers)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.whatsappUsers.id, existing.id));
      return existing;
    }

    const [newUser] = await this.db
      .insert(schema.whatsappUsers)
      .values({
        whatsappId,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning();

    return newUser!;
  }

  private async getMessageIdForPoll(pollId: number): Promise<string> {
    const [poll] = await this.db
      .select()
      .from(schema.polls)
      .where(eq(schema.polls.id, pollId))
      .limit(1);

    if (!poll) throw new Error(`Poll not found: ${pollId}`);
    return poll.whatsappMessageId;
  }

  private async getTeamCurrentSeason(
    teamId: number
  ): Promise<typeof schema.seasons.$inferSelect | null> {
    const [season] = await this.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.teamId, teamId))
      .limit(1);

    return season ?? null;
  }
}
