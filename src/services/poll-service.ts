/**
 * Poll service (T028/T029) — reworked onto the {@link IWhatsAppGateway} port.
 *
 * Owns the on-demand poll lifecycle: re-fetch fixtures (FR-003) → post / force-replace the next
 * confirmed fixture's availability poll → persist its keyset (FR-012) → fold each `onPollVote`
 * delta into a durable, replace-by-voter tally keyed on the voter's canonical identity
 * (FR-013/SC-008). The DB rows are the source of truth — never the Gateway's stateless
 * `aggregateVotes` (research §3a).
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import type { FixtureService } from './fixture-service.js';
import type { Game, Poll, Season } from '../types/entities.js';
import type {
  IWhatsAppGateway,
  Identity,
  MessageRef,
  PollVote,
} from '../whatsapp/gateway-port.js';
import { KeysetStore } from '../whatsapp/keyset-store.js';
import { buildPollSpec } from '../whatsapp/poll-presenter.js';
import { logger } from '../utils/logger.js';

export interface PostPollOptions {
  /** Replace an existing poll for the next fixture (FR-027). `!postpoll` always forces. */
  force?: boolean;
}

/** Structured result of {@link PollService.postOrReplaceNextPoll}. */
export type PostPollOutcome =
  | { outcome: 'posted'; ref: MessageRef; fixture: Game }
  | { outcome: 'replaced'; ref: MessageRef; fixture: Game }
  | { outcome: 'exists'; fixture: Game }
  | { outcome: 'no-fixture' }
  | { outcome: 'fetch-failed'; error: string };

/** Result of a non-sending {@link PollService.previewNextPoll} (the `--dry-run` path). */
export type PreviewOutcome =
  | { outcome: 'preview'; fixture: Game; question: string; options: string[] }
  | { outcome: 'no-fixture' }
  | { outcome: 'fetch-failed'; error: string };

/** Internal result of re-fetching fixtures and picking the next confirmed one. */
type NextFixture =
  | { kind: 'fixture'; game: Game; teamId: number }
  | { kind: 'no-fixture' }
  | { kind: 'fetch-failed'; error: string };

export class PollService {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly fixtureService: FixtureService,
    private readonly gateway: IWhatsAppGateway,
    private readonly groupId: string,
    private readonly keysetStore: KeysetStore = new KeysetStore(db)
  ) {}

  /**
   * Re-fetch fixtures on demand (FR-003), pick the next confirmed fixture, and post — or
   * force-replace an existing poll (FR-027). Shared by the `!postpoll` trigger and the `poll` CLI.
   */
  async postOrReplaceNextPoll(options: PostPollOptions = {}): Promise<PostPollOutcome> {
    const next = await this.resolveNextFixture();
    if (next.kind === 'no-fixture') return { outcome: 'no-fixture' };
    if (next.kind === 'fetch-failed') return { outcome: 'fetch-failed', error: next.error };

    const game = next.game;
    const existing = await this.getPoll(game.id);
    if (existing && !options.force) {
      return { outcome: 'exists', fixture: game };
    }

    // Send first: a send failure aborts before any DB mutation (the existing poll survives).
    const spec = buildPollSpec(game);
    const { ref, keyset } = await this.gateway.sendPoll(this.groupId, spec);

    if (existing) {
      await this.removeExistingPoll(existing);
    }
    await this.keysetStore.persist({
      gameId: game.id,
      question: spec.question,
      postedAt: new Date(),
      keyset,
    });
    // Stamp the post time so the `!postpoll` throttle (T051) can ignore rapid re-triggers.
    await this.recordPollPosted(next.teamId);

    const outcome = existing ? 'replaced' : 'posted';
    logger.info(`Poll ${outcome} for game ${game.id} (${game.opponent})`, {
      pollMessageId: ref.id,
      groupId: this.groupId,
    });
    return { outcome, ref, fixture: game };
  }

  /**
   * Re-fetch fixtures and describe the poll that *would* be posted, without sending (`--dry-run`).
   */
  async previewNextPoll(): Promise<PreviewOutcome> {
    const next = await this.resolveNextFixture();
    if (next.kind === 'no-fixture') return { outcome: 'no-fixture' };
    if (next.kind === 'fetch-failed') return { outcome: 'fetch-failed', error: next.error };

    const spec = buildPollSpec(next.game);
    return {
      outcome: 'preview',
      fixture: next.game,
      question: spec.question,
      options: spec.options,
    };
  }

  /**
   * Process an `onPollVote` delta as the durable tally (FR-013): resolve the voter by canonical
   * identity (get-or-create), then upsert their `poll_responses` row — or delete it on an empty
   * selection (withdrawal). Votes for an unknown/replaced poll are ignored.
   */
  async handlePollVote(vote: PollVote): Promise<void> {
    const [poll] = await this.db
      .select()
      .from(schema.polls)
      .where(
        and(
          eq(schema.polls.pollMessageId, vote.pollId),
          eq(schema.polls.groupId, vote.groupId)
        )
      )
      .limit(1);
    if (!poll) return;

    const user = await this.getOrCreateUser(vote.voter);

    if (vote.selectedOptions.length === 0) {
      // Withdrawal — remove the voter's row entirely.
      await this.db
        .delete(schema.pollResponses)
        .where(
          and(
            eq(schema.pollResponses.pollId, poll.id),
            eq(schema.pollResponses.userId, user.id)
          )
        );
      return;
    }

    // Single-choice availability poll: the first (only) selection is authoritative.
    const option = vote.selectedOptions[0]!;
    const [existing] = await this.db
      .select()
      .from(schema.pollResponses)
      .where(
        and(
          eq(schema.pollResponses.pollId, poll.id),
          eq(schema.pollResponses.userId, user.id)
        )
      )
      .limit(1);

    if (existing) {
      await this.db
        .update(schema.pollResponses)
        .set({ selectedOption: option, respondedAt: new Date() })
        .where(eq(schema.pollResponses.id, existing.id));
    } else {
      await this.db.insert(schema.pollResponses).values({
        pollId: poll.id,
        userId: user.id,
        selectedOption: option,
        respondedAt: new Date(),
      });
    }
  }

  /** Get the poll for a game, or null if none. */
  async getPoll(gameId: number): Promise<Poll | null> {
    const [poll] = await this.db
      .select()
      .from(schema.polls)
      .where(eq(schema.polls.gameId, gameId))
      .limit(1);
    return poll ?? null;
  }

  /** Whether a poll has been posted for the given game. */
  async hasPollForGame(gameId: number): Promise<boolean> {
    return (await this.getPoll(gameId)) !== null;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Re-fetch fixtures from the club site (FR-003) and pick the next confirmed upcoming fixture.
   * A scrape error becomes `fetch-failed`; placeholder/TBD fixtures are skipped by the scraper, so
   * "nothing confirmed" surfaces as `no-fixture`.
   */
  private async resolveNextFixture(): Promise<NextFixture> {
    const [team] = await this.db.select().from(schema.teams).limit(1);
    if (!team) return { kind: 'no-fixture' };

    try {
      await this.fixtureService.syncFixtures(team.id);
    } catch (error) {
      return { kind: 'fetch-failed', error: error instanceof Error ? error.message : String(error) };
    }

    const season = await this.getCurrentSeason(team.id);
    if (!season) return { kind: 'no-fixture' };

    const upcoming = await this.fixtureService.getUpcomingFixtures(season.id);
    const game = upcoming[0];
    return game ? { kind: 'fixture', game, teamId: team.id } : { kind: 'no-fixture' };
  }

  /**
   * The last time a poll was posted/replaced for the (single-operator) team, or `null` if none yet.
   * The `!postpoll` trigger reads this to enforce its 5-minute throttle (T051); the `poll` CLI
   * (admin escape hatch) does not consult it.
   */
  async getLastPollPostedAt(): Promise<Date | null> {
    const [team] = await this.db
      .select({ at: schema.teams.lastPollPostedAt })
      .from(schema.teams)
      .limit(1);
    return team?.at ?? null;
  }

  /** Record that a poll was just posted/replaced, for the throttle window (T051). */
  private async recordPollPosted(teamId: number): Promise<void> {
    await this.db
      .update(schema.teams)
      .set({ lastPollPostedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
  }

  /**
   * Replace an existing poll (FR-027): hard-delete its responses then the poll row, then
   * best-effort delete the WhatsApp message. A failed delete is logged and swallowed — it must
   * never block the replacement (the Gateway's `deleteMessage` never throws).
   */
  private async removeExistingPoll(poll: Poll): Promise<void> {
    await this.db
      .delete(schema.pollResponses)
      .where(eq(schema.pollResponses.pollId, poll.id));
    await this.db.delete(schema.polls).where(eq(schema.polls.id, poll.id));

    const outcome = await this.gateway.deleteMessage({
      id: poll.pollMessageId,
      groupId: poll.groupId,
    });
    if (!outcome.ok) {
      logger.warn('Failed to delete old WhatsApp poll message during replacement', {
        gameId: poll.gameId,
        pollMessageId: poll.pollMessageId,
        reason: outcome.reason,
      });
    }
  }

  private async getCurrentSeason(teamId: number): Promise<Season | null> {
    const [season] = await this.db
      .select()
      .from(schema.seasons)
      .where(and(eq(schema.seasons.teamId, teamId), eq(schema.seasons.isCurrent, true)))
      .limit(1);
    return season ?? null;
  }

  /**
   * Resolve a voter to a single `whatsapp_users` row keyed on `canonicalId` (one row per person,
   * SC-008). Backfills `pn`/`lid`/`displayName` as later address forms reveal them.
   */
  private async getOrCreateUser(
    identity: Identity
  ): Promise<typeof schema.whatsappUsers.$inferSelect> {
    const [existing] = await this.db
      .select()
      .from(schema.whatsappUsers)
      .where(eq(schema.whatsappUsers.canonicalId, identity.canonicalId))
      .limit(1);

    if (existing) {
      await this.db
        .update(schema.whatsappUsers)
        .set({
          lastSeenAt: new Date(),
          pn: identity.pn ?? existing.pn,
          lid: identity.lid ?? existing.lid,
          displayName: identity.displayHint ?? existing.displayName,
        })
        .where(eq(schema.whatsappUsers.id, existing.id));
      return existing;
    }

    const [created] = await this.db
      .insert(schema.whatsappUsers)
      .values({
        canonicalId: identity.canonicalId,
        pn: identity.pn ?? null,
        lid: identity.lid ?? null,
        displayName: identity.displayHint ?? null,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning();
    return created!;
  }
}
