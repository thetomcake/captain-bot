import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { statsCommand } from '#src/cli/commands/stats.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * CLI `stats` command (T036, US4 — FR-023, view-only). Seeds stats across two seasons and asserts
 * `--game`/`--season` group by player (canonical identity) with goals/assists/weight/food in both
 * human and `--json` form, and that a previous season is still viewable (SC-006/SC-007).
 */
describe('CLI stats command (US4, view-only)', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let exitCode: number | null;

  // IDs seeded in beforeEach, referenced by the tests.
  let season1Game: number;
  let season2Game: number;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ databasePath: ':memory:' }));
    closeDatabase();

    const { db } = getDatabase();
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();

    // Two seasons — season 1 (past), season 2 (current). History must survive (SC-007).
    const [s1] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: false })
      .returning();
    const [s2] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 2, isCurrent: true })
      .returning();

    const [g1] = await db
      .insert(schema.games)
      .values({
        seasonId: s1!.id,
        gameDate: new Date(Date.now() - 60 * DAY_MS),
        opponent: 'Old Rivals',
        venue: 'Home',
        status: 'completed',
      })
      .returning();
    const [g2] = await db
      .insert(schema.games)
      .values({
        seasonId: s2!.id,
        gameDate: new Date(Date.now() - 2 * DAY_MS),
        opponent: 'Red Devils',
        venue: 'Home',
        status: 'completed',
      })
      .returning();
    season1Game = g1!.id;
    season2Game = g2!.id;

    const [alice] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'alice@id', displayName: 'Alice' })
      .returning();
    const [bob] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'bob@id', displayName: 'Bob' })
      .returning();

    // Season 1 stats (previous season — must remain viewable).
    await db.insert(schema.statRecords).values({
      gameId: g1!.id,
      userId: alice!.id,
      goals: 1,
      assists: 0,
      weightDirection: 'same',
      foodTracking: false,
      confidenceScore: 90,
    });

    // Season 2 stats for two players.
    await db.insert(schema.statRecords).values([
      {
        gameId: g2!.id,
        userId: alice!.id,
        goals: 2,
        assists: 1,
        weightDirection: 'down',
        foodTracking: true,
        confidenceScore: 95,
      },
      {
        gameId: g2!.id,
        userId: bob!.id,
        goals: 0,
        assists: 2,
        weightDirection: 'up',
        foodTracking: false,
        confidenceScore: 80,
      },
    ]);

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

  describe('stats --game <id>', () => {
    it('groups by player with goals/assists/weight/food (human-readable)', async () => {
      await statsCommand({ game: season2Game });

      const output = consoleOutput.join('\n');
      expect(output).toContain('Alice');
      expect(output).toContain('Bob');
      expect(output).toContain('Red Devils');
      // goals/assists/weight/food are surfaced
      expect(output).toContain('down');
      expect(exitCode).toBe(0);
    });

    it('outputs player-grouped JSON with --json', async () => {
      await statsCommand({ game: season2Game, json: true });

      const json = JSON.parse(consoleOutput.join(''));
      expect(Array.isArray(json.players)).toBe(true);
      expect(json.players).toHaveLength(2);

      const player = json.players[0];
      expect(player).toHaveProperty('canonicalId');
      expect(player).toHaveProperty('totalGoals');
      expect(player).toHaveProperty('totalAssists');
      expect(Array.isArray(player.games)).toBe(true);
      expect(player.games[0]).toHaveProperty('goals');
      expect(player.games[0]).toHaveProperty('assists');
      expect(player.games[0]).toHaveProperty('weightDirection');
      expect(player.games[0]).toHaveProperty('foodTracking');
      expect(exitCode).toBe(0);
    });

    it('exits 1 when the game has no stats', async () => {
      // A game id that exists but has no stat_records (season 1 game has only Alice;
      // use a non-existent id for a clean empty result).
      await statsCommand({ game: 999999 });
      expect(exitCode).toBe(1);
    });
  });

  describe('stats --season <n>', () => {
    it('groups by player and aggregates totals across the season (--json)', async () => {
      await statsCommand({ season: 2, json: true });

      const json = JSON.parse(consoleOutput.join(''));
      expect(json.players).toHaveLength(2);
      const alice = json.players.find((p: any) => p.canonicalId === 'alice@id');
      expect(alice.totalGoals).toBe(2);
      expect(alice.totalAssists).toBe(1);
      expect(exitCode).toBe(0);
    });

    it('still shows a previous season (history preserved, SC-007)', async () => {
      await statsCommand({ season: 1, json: true });

      const json = JSON.parse(consoleOutput.join(''));
      expect(json.players).toHaveLength(1);
      expect(json.players[0].canonicalId).toBe('alice@id');
      expect(json.players[0].totalGoals).toBe(1);
      expect(exitCode).toBe(0);
    });

    it('exits 1 when the season has no stats or does not exist', async () => {
      await statsCommand({ season: 99 });
      expect(exitCode).toBe(1);
    });
  });

  describe('argument validation', () => {
    it('exits 2 when neither --game nor --season is given', async () => {
      await statsCommand({});
      expect(exitCode).toBe(2);
    });
  });
});
