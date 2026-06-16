/**
 * Stat service (T034, US3) — capture per-player stats from authorized-group chat.
 *
 * On each inbound message: run the pure {@link extractStats} parser, gate on the ≥70% confidence
 * threshold (FR-018) and the 3-day post-game window (FR-017), resolve the sender to a single
 * `whatsapp_users` row by canonical identity (FR-019/SC-008), then write `stat_records` —
 * applying defaults on the first capture (FR-020) and merging only the mentioned fields on later
 * messages (FR-019). WhatsApp edits/deletes never reach here: the Gateway surfaces only genuine
 * inbound messages, so the player-driven field-level override is the only way stored stats change
 * (no captain-side correction, FR-024).
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import type { Game, StatRecord, WeightDirection } from '../types/entities.js';
import type { Identity, IncomingMessage } from '../whatsapp/gateway-port.js';
import { extractStats, CONFIDENCE_THRESHOLD } from '../stats/stat-extractor.js';
import { logger } from '../utils/logger.js';

/** Post-game window during which messages are interpreted as stat reports (FR-017). */
export const STAT_WINDOW_DAYS = 3;
const STAT_WINDOW_MS = STAT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * One game's stat line for a single player, enriched with the player's canonical identity and the
 * game it belongs to. The view layer (US4) groups these by player.
 */
export interface PlayerStatLine {
  canonicalId: string;
  displayName: string | null;
  gameId: number;
  opponent: string;
  gameDate: Date;
  goals: number;
  assists: number;
  weightDirection: WeightDirection | null;
  foodTracking: boolean | null;
}

export class StatService {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Interpret an inbound message and capture/merge stats if it is a confident stat report sent
   * within a game's 3-day window. Returns the written `stat_records` row, or `null` when the
   * message is treated as ordinary chat (below threshold, no text, or outside any window).
   */
  async captureFromMessage(message: IncomingMessage): Promise<StatRecord | null> {
    if (!message.text) return null;

    const extracted = extractStats(message.text);
    if (extracted.confidence < CONFIDENCE_THRESHOLD) return null;

    const game = await this.findRelevantGame(message.timestamp);
    if (!game) return null;

    const user = await this.getOrCreateUser(message.sender);
    const row = await this.upsertStats(game.id, user.id, extracted, message.text);

    logger.info('Captured stats from chat message', {
      gameId: game.id,
      userId: user.id,
      sender: message.sender.canonicalId,
      confidence: extracted.confidence,
    });
    return row;
  }

  // ── Read queries (US4, view-only — FR-023) ───────────────────────────────

  /**
   * All stat lines for a single game, joined to the player's canonical identity. One row per
   * player (the `unique(gameId, userId)` constraint guarantees no duplicates). Ordered by display
   * name so the grouped view is stable.
   */
  async getStatsByGame(gameId: number): Promise<PlayerStatLine[]> {
    return this.selectStatLines(eq(schema.games.id, gameId));
  }

  /**
   * All stat lines for every game in a season, joined to the player's canonical identity. A player
   * may appear once per game; the view layer aggregates per player. Ordered by player then game
   * date so a player's games read chronologically.
   */
  async getStatsBySeason(seasonId: number): Promise<PlayerStatLine[]> {
    return this.selectStatLines(eq(schema.games.seasonId, seasonId));
  }

  /** Shared join + projection for the two read queries above. */
  private async selectStatLines(
    where: ReturnType<typeof eq>
  ): Promise<PlayerStatLine[]> {
    const rows = await this.db
      .select({
        canonicalId: schema.whatsappUsers.canonicalId,
        displayName: schema.whatsappUsers.displayName,
        gameId: schema.games.id,
        opponent: schema.games.opponent,
        gameDate: schema.games.gameDate,
        goals: schema.statRecords.goals,
        assists: schema.statRecords.assists,
        weightDirection: schema.statRecords.weightDirection,
        foodTracking: schema.statRecords.foodTracking,
      })
      .from(schema.statRecords)
      .innerJoin(schema.games, eq(schema.statRecords.gameId, schema.games.id))
      .innerJoin(schema.whatsappUsers, eq(schema.statRecords.userId, schema.whatsappUsers.id))
      .where(where)
      .orderBy(asc(schema.whatsappUsers.displayName), asc(schema.games.gameDate));
    return rows as PlayerStatLine[];
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * The game whose 3-day post-game window contains `ts` — i.e. the most recent game already
   * played (`gameDate <= ts`) within the last {@link STAT_WINDOW_DAYS} days. `null` if none.
   */
  private async findRelevantGame(ts: Date): Promise<Game | null> {
    const windowStart = new Date(ts.getTime() - STAT_WINDOW_MS);
    const [game] = await this.db
      .select()
      .from(schema.games)
      .where(and(lte(schema.games.gameDate, ts), gte(schema.games.gameDate, windowStart)))
      .orderBy(desc(schema.games.gameDate))
      .limit(1);
    return game ?? null;
  }

  /**
   * Insert a `stat_records` row with defaults on first capture (FR-020), or merge only the
   * mentioned fields into an existing row (FR-019), keyed on `unique(gameId, userId)`.
   */
  private async upsertStats(
    gameId: number,
    userId: number,
    extracted: ReturnType<typeof extractStats>,
    sourceMessage: string
  ): Promise<StatRecord> {
    const [existing] = await this.db
      .select()
      .from(schema.statRecords)
      .where(and(eq(schema.statRecords.gameId, gameId), eq(schema.statRecords.userId, userId)))
      .limit(1);

    if (!existing) {
      const [created] = await this.db
        .insert(schema.statRecords)
        .values({
          gameId,
          userId,
          goals: extracted.goals ?? 0,
          assists: extracted.assists ?? 0,
          weightDirection: extracted.weightDirection ?? 'unknown',
          foodTracking: extracted.foodTracking ?? false,
          confidenceScore: extracted.confidence,
          sourceMessage,
          capturedAt: new Date(),
        })
        .returning();
      return created!;
    }

    // Merge: update only the fields this message mentioned, leaving the rest intact.
    const update: Partial<typeof schema.statRecords.$inferInsert> = {
      confidenceScore: Math.max(existing.confidenceScore, extracted.confidence),
      sourceMessage,
    };
    if (extracted.goals !== undefined) update.goals = extracted.goals;
    if (extracted.assists !== undefined) update.assists = extracted.assists;
    if (extracted.weightDirection !== undefined) update.weightDirection = extracted.weightDirection;
    if (extracted.foodTracking !== undefined) update.foodTracking = extracted.foodTracking;

    const [updated] = await this.db
      .update(schema.statRecords)
      .set(update)
      .where(eq(schema.statRecords.id, existing.id))
      .returning();
    return updated!;
  }

  /**
   * Resolve a sender to a single `whatsapp_users` row keyed on `canonicalId` (one row per person,
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
