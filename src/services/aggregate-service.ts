/**
 * Fetches a season's rows and assembles the {@link AggregationInput} the pure aggregation core
 * consumes. It owns the season→participation mapping that encodes the attended-games definition
 * (a completed game a player voted "Yes" to), and resolves the season by number — distinguishing a
 * non-existent season ("not found") from a valid season with no data.
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import type { Season } from '../types/entities.js';
import type {
  AggregationInput,
  AttendanceReport,
  GameStatus,
  Participation,
  PlayerAggregate,
  RankMetric,
  SeasonAggregate,
} from '../stats/aggregations.js';
import {
  aggregateAttendance,
  aggregatePlayers,
  aggregateReport,
  aggregateSeason,
} from '../stats/aggregations.js';
import { SeasonService } from './season-service.js';
import { getPollOptions } from '../whatsapp/poll-presenter.js';

const TEAM_ID = 1; // single-operator team

export type SeasonResolution = { kind: 'found'; season: Season } | { kind: 'not-found' };

export class AggregateService {
  private readonly seasons: SeasonService;

  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {
    this.seasons = new SeasonService(db);
  }

  /**
   * Resolve a season by its number, defaulting to the current season when none is given. A missing
   * season (or no current season) is signalled distinctly so the caller can emit "not found" (exit
   * 1) rather than "no data" (exit 2).
   */
  async resolveSeason(seasonNumber?: number): Promise<SeasonResolution> {
    if (seasonNumber === undefined) {
      const current = await this.seasons.getCurrentSeason(TEAM_ID);
      return current ? { kind: 'found', season: current } : { kind: 'not-found' };
    }
    const all = await this.seasons.getSeasons(TEAM_ID);
    const season = all.find((s) => s.seasonNumber === seasonNumber);
    return season ? { kind: 'found', season } : { kind: 'not-found' };
  }

  /**
   * Build the season's {@link AggregationInput}: all games (for status counts), the count of
   * completed poll-bearing fixtures (the attendance denominator), and one participation row per
   * (completed game, player) the player attended OR has a stat line for. An attended game with no
   * stat record becomes a 0-goal/0-assist, non-`down`, not-tracked attended game; a null
   * `foodTracking` is coerced to false (same default as `goals → 0`).
   */
  async getSeasonData(seasonId: number): Promise<AggregationInput> {
    const season = await this.seasons.getSeason(seasonId);
    const scopeLabel = season ? `Season ${season.seasonNumber}` : `Season ${seasonId}`;

    const gameRows = await this.db
      .select({ gameId: schema.games.id, status: schema.games.status })
      .from(schema.games)
      .where(eq(schema.games.seasonId, seasonId));
    const games: GameStatus[] = gameRows.map((g) => ({ gameId: g.gameId, status: g.status }));

    // pollFixtureCount = completed games with a poll (one poll per game, so row count is the count).
    const pollRows = await this.db
      .select({ gameId: schema.polls.gameId })
      .from(schema.polls)
      .innerJoin(schema.games, eq(schema.polls.gameId, schema.games.id))
      .where(and(eq(schema.games.seasonId, seasonId), eq(schema.games.status, 'completed')));
    const pollFixtureCount = pollRows.length;

    const yesOption = getPollOptions()[0]!;
    const voteRows = await this.db
      .select({
        gameId: schema.polls.gameId,
        canonicalId: schema.whatsappUsers.canonicalId,
        displayName: schema.whatsappUsers.displayName,
      })
      .from(schema.pollResponses)
      .innerJoin(schema.polls, eq(schema.pollResponses.pollId, schema.polls.id))
      .innerJoin(schema.games, eq(schema.polls.gameId, schema.games.id))
      .innerJoin(schema.whatsappUsers, eq(schema.pollResponses.userId, schema.whatsappUsers.id))
      .where(
        and(
          eq(schema.games.seasonId, seasonId),
          eq(schema.games.status, 'completed'),
          eq(schema.pollResponses.selectedOption, yesOption)
        )
      );

    const statRows = await this.db
      .select({
        gameId: schema.statRecords.gameId,
        canonicalId: schema.whatsappUsers.canonicalId,
        displayName: schema.whatsappUsers.displayName,
        goals: schema.statRecords.goals,
        assists: schema.statRecords.assists,
        weightDirection: schema.statRecords.weightDirection,
        foodTracking: schema.statRecords.foodTracking,
      })
      .from(schema.statRecords)
      .innerJoin(schema.games, eq(schema.statRecords.gameId, schema.games.id))
      .innerJoin(schema.whatsappUsers, eq(schema.statRecords.userId, schema.whatsappUsers.id))
      .where(and(eq(schema.games.seasonId, seasonId), eq(schema.games.status, 'completed')));

    const byKey = new Map<string, Participation>();
    const key = (gameId: number, canonicalId: string) => `${gameId}::${canonicalId}`;

    for (const v of voteRows) {
      byKey.set(key(v.gameId, v.canonicalId), {
        gameId: v.gameId,
        canonicalId: v.canonicalId,
        displayName: v.displayName,
        attended: true,
        goals: 0,
        assists: 0,
        weightDirection: null,
        foodTracking: false,
        hasStatRecord: false,
      });
    }

    for (const s of statRows) {
      const k = key(s.gameId, s.canonicalId);
      const existing = byKey.get(k);
      if (existing) {
        existing.goals = s.goals;
        existing.assists = s.assists;
        existing.weightDirection = s.weightDirection ?? null;
        existing.foodTracking = s.foodTracking ?? false;
        existing.hasStatRecord = true;
      } else {
        byKey.set(k, {
          gameId: s.gameId,
          canonicalId: s.canonicalId,
          displayName: s.displayName,
          attended: false,
          goals: s.goals,
          assists: s.assists,
          weightDirection: s.weightDirection ?? null,
          foodTracking: s.foodTracking ?? false,
          hasStatRecord: true,
        });
      }
    }

    return { scopeLabel, games, pollFixtureCount, participation: [...byKey.values()] };
  }

  /** The team season summary; `hasData === false` is the caller's "no data" signal. */
  async getSeasonSummary(seasonId: number): Promise<SeasonAggregate> {
    return aggregateSeason(await this.getSeasonData(seasonId));
  }

  /** Per-player aggregates ranked by `rankBy` (default `goals`), highest-first. */
  async getPlayerAggregates(seasonId: number, rankBy?: RankMetric): Promise<PlayerAggregate[]> {
    return aggregatePlayers(await this.getSeasonData(seasonId), { rankBy });
  }

  /** The shareable report's data — `{ season, players }`; `season.hasData` is the "no data" signal. */
  async getReport(
    seasonId: number
  ): Promise<{ season: SeasonAggregate; players: PlayerAggregate[] }> {
    return aggregateReport(await this.getSeasonData(seasonId));
  }

  /** Attendance / turnout for the season; `hasData === false` is the caller's "no data" signal. */
  async getAttendance(seasonId: number): Promise<AttendanceReport> {
    return aggregateAttendance(await this.getSeasonData(seasonId));
  }
}
