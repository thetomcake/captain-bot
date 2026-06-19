import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { AggregateService } from '#src/services/aggregate-service.js';
import { statsCommand } from '#src/cli/commands/stats.js';
import { getPollOptions } from '#src/whatsapp/poll-presenter.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAY_MS = 24 * 60 * 60 * 1000;
const YES = getPollOptions()[0]!;

/**
 * Hand-seeded season exercising the attended-games definition (spec-008 clarifications 2026-06-19):
 * an attended game with no stat line, a stat line on a non-attended game, a null `foodTracking`, a
 * completed game with no poll, and an upcoming polled game. Figures are computed by hand in the
 * assertions below.
 */
describe('spec-008 aggregate stats (service + CLI)', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let exitCode: number | null;

  let season2Id: number;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ databasePath: ':memory:' }));
    closeDatabase();

    const { db } = getDatabase();
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();

    // Season 1 (past) — a minimal completed game, proves non-current seasons aggregate (FR-003).
    const [s1] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: false })
      .returning();
    // Season 2 (current) — the rich season under test.
    const [s2] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 2, isCurrent: true })
      .returning();
    // Season 3 — exists but holds no games/data (the "no data" case).
    await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 3, isCurrent: false })
      .returning();
    season2Id = s2!.id;

    const [alice] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'alice@id', displayName: 'Alice' })
      .returning();
    const [bob] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'bob@id', displayName: 'Bob' })
      .returning();
    const [carol] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'carol@id', displayName: 'Carol' })
      .returning();

    // ── Season 2 games ──
    const [g1] = await db
      .insert(schema.games)
      .values({
        seasonId: s2!.id,
        gameDate: new Date(Date.now() - 20 * DAY_MS),
        opponent: 'Red Devils',
        venue: 'Home',
        status: 'completed',
      })
      .returning();
    const [g2] = await db
      .insert(schema.games)
      .values({
        seasonId: s2!.id,
        gameDate: new Date(Date.now() - 13 * DAY_MS),
        opponent: 'Blue Lions',
        venue: 'Away',
        status: 'completed',
      })
      .returning();
    const [g3] = await db
      .insert(schema.games)
      .values({
        seasonId: s2!.id,
        gameDate: new Date(Date.now() - 6 * DAY_MS),
        opponent: 'Green Giants',
        venue: 'Home',
        status: 'completed', // completed but NO poll → excluded from pollFixtureCount
      })
      .returning();
    await db.insert(schema.games).values({
      seasonId: s2!.id,
      gameDate: new Date(Date.now() - 27 * DAY_MS),
      opponent: 'Cancelled FC',
      venue: 'Home',
      status: 'cancelled',
    });
    const [g5] = await db
      .insert(schema.games)
      .values({
        seasonId: s2!.id,
        gameDate: new Date(Date.now() + 5 * DAY_MS),
        opponent: 'Future United',
        venue: 'Away',
        status: 'upcoming', // upcoming poll → excluded from pollFixtureCount
      })
      .returning();

    // ── Polls on g1, g2 (completed) and g5 (upcoming) — none on g3 ──
    const mkPoll = (gameId: number, n: number) => ({
      gameId,
      pollMessageId: `poll-${n}`,
      groupId: 'group@g.us',
      messageSecret: 'c2VjcmV0',
      postedAt: new Date(Date.now() - 28 * DAY_MS),
      pollQuestion: `Poll ${n}`,
      pollOptions: getPollOptions(),
    });
    const [p1] = await db.insert(schema.polls).values(mkPoll(g1!.id, 1)).returning();
    const [p2] = await db.insert(schema.polls).values(mkPoll(g2!.id, 2)).returning();
    const [p5] = await db.insert(schema.polls).values(mkPoll(g5!.id, 5)).returning();

    // ── Yes votes ──
    const yes = (pollId: number, userId: number) => ({
      pollId,
      userId,
      selectedOption: YES,
      respondedAt: new Date(),
    });
    await db.insert(schema.pollResponses).values([
      yes(p1!.id, alice!.id), // g1: alice attended (also has a stat line)
      yes(p1!.id, bob!.id), // g1: bob attended, NO stat line → 0/0 attended game
      yes(p2!.id, alice!.id), // g2: alice attended (stat line has null food)
      yes(p2!.id, bob!.id), // g2: bob attended (has stat line)
      yes(p5!.id, alice!.id), // g5 upcoming: excluded — not a completed fixture
    ]);

    // ── Stat records (completed games) ──
    await db.insert(schema.statRecords).values([
      // g1
      {
        gameId: g1!.id,
        userId: alice!.id,
        goals: 2,
        assists: 1,
        weightDirection: 'down',
        foodTracking: true,
        confidenceScore: 95,
      },
      {
        gameId: g1!.id,
        userId: carol!.id, // carol did NOT vote → attended:false on a completed game
        goals: 1,
        assists: 0,
        weightDirection: 'up',
        foodTracking: false,
        confidenceScore: 90,
      },
      // g2
      {
        gameId: g2!.id,
        userId: alice!.id,
        goals: 3,
        assists: 0,
        weightDirection: 'same',
        foodTracking: null, // null food → coerced to false (not tracked)
        confidenceScore: 88,
      },
      {
        gameId: g2!.id,
        userId: bob!.id,
        goals: 0,
        assists: 2,
        weightDirection: 'down',
        foodTracking: true,
        confidenceScore: 80,
      },
      // g3 (completed, no poll) — alice has a stat line but no Yes vote
      {
        gameId: g3!.id,
        userId: alice!.id,
        goals: 5,
        assists: 5,
        weightDirection: 'down',
        foodTracking: true,
        confidenceScore: 70,
      },
    ]);

    // Season 1 — one completed game with a poll, alice attends + scores.
    const [s1g1] = await db
      .insert(schema.games)
      .values({
        seasonId: s1!.id,
        gameDate: new Date(Date.now() - 200 * DAY_MS),
        opponent: 'Old Rivals',
        venue: 'Home',
        status: 'completed',
      })
      .returning();
    const [s1p1] = await db.insert(schema.polls).values(mkPoll(s1g1!.id, 101)).returning();
    await db.insert(schema.pollResponses).values(yes(s1p1!.id, alice!.id));
    await db.insert(schema.statRecords).values({
      gameId: s1g1!.id,
      userId: alice!.id,
      goals: 1,
      assists: 0,
      weightDirection: 'down',
      foodTracking: true,
      confidenceScore: 90,
    });

    consoleOutput = [];
    consoleErrors = [];
    exitCode = null;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;
    console.log = (...args: any[]) => void consoleOutput.push(args.join(' '));
    console.error = (...args: any[]) => void consoleErrors.push(args.join(' '));
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as any;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    closeDatabase();
  });

  describe('AggregateService.getSeasonData — the attended-games input builder', () => {
    it('encodes the attended-games definition at the service boundary (spec-008/FR-005, FR-007, FR-009, FR-015)', async () => {
      const { db } = getDatabase();
      const input = await new AggregateService(db).getSeasonData(season2Id);

      // pollFixtureCount = completed games that have a poll: g1, g2 (g3 has none, g5 is upcoming).
      expect(input.pollFixtureCount).toBe(2);

      const row = (gameOpponentRows: typeof input.participation, canonicalId: string) =>
        gameOpponentRows.filter((p) => p.canonicalId === canonicalId);

      // Attended game with no stat line: bob on g1 → attended, 0/0, not tracked.
      const bobAttendedNoStat = input.participation.find(
        (p) => p.canonicalId === 'bob@id' && p.attended && !p.hasStatRecord
      );
      expect(bobAttendedNoStat).toBeDefined();
      expect(bobAttendedNoStat!.goals).toBe(0);
      expect(bobAttendedNoStat!.assists).toBe(0);
      expect(bobAttendedNoStat!.foodTracking).toBe(false);
      expect(bobAttendedNoStat!.weightDirection).toBeNull();

      // Null foodTracking is coerced to false (same default as goals → 0): alice on g2.
      const aliceNullFood = input.participation.find(
        (p) => p.canonicalId === 'alice@id' && p.attended && p.goals === 3
      );
      expect(aliceNullFood).toBeDefined();
      expect(aliceNullFood!.foodTracking).toBe(false);
      expect(aliceNullFood!.hasStatRecord).toBe(true);

      // Stat line on a non-attended completed game: carol on g1.
      const carolRows = row(input.participation, 'carol@id');
      expect(carolRows).toHaveLength(1);
      expect(carolRows[0]!.attended).toBe(false);
      expect(carolRows[0]!.hasStatRecord).toBe(true);

      // Players resolve once per canonical id (no duplicate identities).
      const aliceRows = row(input.participation, 'alice@id');
      expect(aliceRows.every((p) => p.canonicalId === 'alice@id')).toBe(true);

      // Games-by-status source rows: 3 completed, 1 cancelled, 1 upcoming.
      const byStatus = input.games.reduce<Record<string, number>>((acc, g) => {
        acc[g.status] = (acc[g.status] ?? 0) + 1;
        return acc;
      }, {});
      expect(byStatus).toEqual({ completed: 3, cancelled: 1, upcoming: 1 });
    });
  });

  describe('stats --summary (spec-008/US-1)', () => {
    it('prints the team summary for the current season in human form (FR-001, FR-014)', async () => {
      await statsCommand({ summary: true, season: 2 });
      const out = consoleOutput.join('\n');
      expect(out).toContain('Season 2');
      expect(out).toContain('3 completed');
      expect(out).toContain('11'); // total goals
      expect(out).toContain('8'); // total assists
      expect(exitCode).toBe(0);
    });

    it('emits the same figures as JSON with --json (FR-012)', async () => {
      await statsCommand({ summary: true, season: 2, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.totalGoals).toBe(11);
      expect(json.totalAssists).toBe(8);
      expect(json.gamesByStatus).toEqual({ completed: 3, cancelled: 1, upcoming: 1 });
      expect(json.squadSize).toBe(3);
      expect(json.averageTurnoutPerFixture).toBe(2);
      expect(json.goalsPerGame).toBeCloseTo(11 / 3, 10);
      expect(json.squadWeightLossRate).toBeCloseTo(0.5, 10);
      expect(json.squadFoodTrackingRate).toBeCloseTo(0.5, 10);
      expect(exitCode).toBe(0);
    });

    it('defaults to the current season when --season is omitted', async () => {
      await statsCommand({ summary: true, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.scopeLabel).toBe('Season 2'); // season 2 is current
      expect(exitCode).toBe(0);
    });

    it('aggregates a past (non-current) season (FR-003)', async () => {
      await statsCommand({ summary: true, season: 1, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.totalGoals).toBe(1);
      expect(exitCode).toBe(0);
    });

    it('exits 2 with "no data" for a valid but empty season (FR-011, SC-004)', async () => {
      await statsCommand({ summary: true, season: 3 });
      expect(exitCode).toBe(2);
      expect(consoleErrors.join('\n').toLowerCase()).toContain('no data');
    });

    it('exits 1 with "not found" for a non-existent season (FR-011)', async () => {
      await statsCommand({ summary: true, season: 999 });
      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n').toLowerCase()).toContain('not found');
    });

    it('exits 2 on a usage error when combined with --game (mutual exclusivity)', async () => {
      await statsCommand({ summary: true, game: 1 });
      expect(exitCode).toBe(2);
    });

    it('leaves the legacy raw season view unchanged when no aggregate flag is given', async () => {
      await statsCommand({ season: 2, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(Array.isArray(json.players)).toBe(true); // legacy player-grouped shape
      expect(exitCode).toBe(0);
    });
  });

  describe('stats --players (spec-008/US-2)', () => {
    it('emits one row per player ranked by goals with attended-games figures (FR-004, FR-006)', async () => {
      await statsCommand({ players: true, season: 2, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.rankBy).toBe('goals');
      expect(Array.isArray(json.players)).toBe(true);
      expect(json.players).toHaveLength(3); // alice, bob, carol — one per canonical id
      const alice = json.players.find((pl: any) => pl.canonicalId === 'alice@id');
      expect(alice.attendedGames).toBe(2); // g1, g2 — g3 (not attended) excluded
      expect(alice.totalGoals).toBe(5); // 2 + 3
      expect(alice.goalsPerGame).toBeCloseTo(5 / 2, 10);
      expect(json.players[0].canonicalId).toBe('alice@id'); // highest goals first
      expect(exitCode).toBe(0);
    });

    it('reorders by a chosen --rank metric (FR-006)', async () => {
      await statsCommand({ players: true, season: 2, rank: 'assists', json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.rankBy).toBe('assists');
      expect(json.players[0].canonicalId).toBe('bob@id'); // 2 assists > alice 1
      expect(exitCode).toBe(0);
    });

    it('renders n/a for a zero-attended-game player in human output (SC-004)', async () => {
      await statsCommand({ players: true, season: 2 });
      const out = consoleOutput.join('\n');
      expect(out).toContain('Carol');
      expect(out).toContain('n/a'); // carol attended 0 → null per-game rates
      expect(exitCode).toBe(0);
    });

    it('exits 2 on an unknown --rank metric (usage error)', async () => {
      await statsCommand({ players: true, season: 2, rank: 'nonsense' });
      expect(exitCode).toBe(2);
    });
  });

  describe('stats --report (spec-008/US-4)', () => {
    it('prints a single chat-safe block: team section + one line per attended player (FR-016, FR-017)', async () => {
      await statsCommand({ report: true, season: 2 });
      const out = consoleOutput.join('\n');
      expect(out).toContain('Season 2');
      expect(out).toContain('Alice');
      expect(out).toContain('Bob');
      expect(out).not.toContain('Carol'); // attended-players-only
      // FR-016 paste-safety: no tab, box-drawing, or ANSI escape characters.
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/[\t\x1b─-╿]/);
      expect(exitCode).toBe(0);
    });

    it('emits { season, players } as JSON with --json (FR-013)', async () => {
      await statsCommand({ report: true, season: 2, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.season.totalGoals).toBe(11);
      expect(Array.isArray(json.players)).toBe(true);
      expect(exitCode).toBe(0);
    });

    it('exits 2 with "no data" for an empty season (FR-011)', async () => {
      await statsCommand({ report: true, season: 3 });
      expect(exitCode).toBe(2);
      expect(consoleErrors.join('\n').toLowerCase()).toContain('no data');
    });
  });

  describe('stats --attendance (spec-008/US-3)', () => {
    it('prints per-player attendance % and the squad average turnout (FR-009, FR-015)', async () => {
      await statsCommand({ attendance: true, season: 2, json: true });
      const json = JSON.parse(consoleOutput.join(''));
      expect(json.averageTurnoutPerFixture).toBe(2); // 4 Yes / 2 fixtures (g3 no poll excluded)
      const alice = json.players.find((pl: any) => pl.canonicalId === 'alice@id');
      expect(alice.attended).toBe(2);
      expect(alice.eligible).toBe(2); // pollFixtureCount — g3 (no poll) never counts
      expect(alice.attendanceRate).toBeCloseTo(2 / 2, 10);
      expect(exitCode).toBe(0);
    });

    it('prints attendance in human form', async () => {
      await statsCommand({ attendance: true, season: 2 });
      const out = consoleOutput.join('\n');
      expect(out).toContain('Season 2');
      expect(out).toContain('Alice');
      expect(exitCode).toBe(0);
    });
  });
});
