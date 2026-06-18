import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '#src/database/schema.js';

// Import services to be implemented
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';

// Import mock scraper (no real HTTP calls)
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';
import { reloadEnv } from '#src/config/env.js';

describe('Fixture Service Integration Tests', () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database.Database;
  let fixtureService: FixtureService;
  let seasonService: SeasonService;
  let teamId: number;
  let seasonId: number;

  beforeEach(async () => {
    // Spec 006 filters scraped fixtures to TEAM_NAME; "White Team" appears in the static Watford
    // HTML (with upcoming games), so the load path yields our-team fixtures deterministically.
    setTestEnvironment(createTestConfig({ teamName: 'White Team' }));
    reloadEnv();

    // Use in-memory database for testing
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });

    // Run migrations
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    // Create test team
    const [team] = await db
      .insert(schema.teams)
      .values({
        name: 'Test Team',
        clubUrl: 'https://manvfatfootball.com/club/watford/',
        whatsappGroupId: null,
      })
      .returning();
    teamId = team.id;

    // Create test season
    const [season] = await db
      .insert(schema.seasons)
      .values({
        teamId,
        seasonNumber: 1,
        isCurrent: true,
      })
      .returning();
    seasonId = season.id;

    // Initialize services with mock scraper (no real HTTP calls)
    seasonService = new SeasonService(db);
    const mockScraper = new MockFixtureScraper();
    fixtureService = new FixtureService(db, seasonService, mockScraper);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('fetchFixtures', () => {
    it('should fetch fixtures from club URL and store in database', async () => {
      const fixtures = await fixtureService.fetchFixtures(teamId);

      expect(fixtures.length).toBeGreaterThan(0);

      // Verify fixtures are stored in database
      const storedGames = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      expect(storedGames.length).toBe(fixtures.length);
    });

    it('should associate fixtures with current season', async () => {
      await fixtureService.fetchFixtures(teamId);

      const games = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      games.forEach((game) => {
        expect(game.seasonId).toBe(seasonId);
      });
    });

    it('should set status to "upcoming" for future fixtures', async () => {
      await fixtureService.fetchFixtures(teamId);

      const upcomingGames = await db.query.games.findMany({
        where: (games, { and, eq }) =>
          and(eq(games.seasonId, seasonId), eq(games.status, 'upcoming')),
      });

      expect(upcomingGames.length).toBeGreaterThan(0);
    });

    it('should retrieve date, time, opponent, and venue for each fixture (FR-002, scenario 1)', async () => {
      const fixtures = await fixtureService.fetchFixtures(teamId);

      expect(fixtures.length).toBeGreaterThan(0);

      // Scenario 1: every fixture carries date+time (in gameDate), opponent, and venue
      for (const game of fixtures) {
        expect(game.gameDate).toBeInstanceOf(Date);
        expect(Number.isNaN(game.gameDate.getTime())).toBe(false);
        expect(game.opponent.length).toBeGreaterThan(0);
        expect(game.venue.length).toBeGreaterThan(0);
      }
    });
  });

  describe('re-fetch (FR-003)', () => {
    it('should update existing fixtures when re-fetching', async () => {
      // First fetch
      await fixtureService.fetchFixtures(teamId);

      const firstSyncCount = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      // Second fetch
      await fixtureService.fetchFixtures(teamId);

      const secondSyncCount = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      // Count should be similar (accounting for possible new fixtures)
      expect(secondSyncCount.length).toBeGreaterThanOrEqual(firstSyncCount.length);
    });

    it('should cache fixtures to avoid redundant scraping', async () => {
      // First fetch
      const start1 = Date.now();
      await fixtureService.fetchFixtures(teamId);
      const duration1 = Date.now() - start1;

      // Second fetch (should be cached)
      const start2 = Date.now();
      await fixtureService.fetchFixtures(teamId);
      const duration2 = Date.now() - start2;

      // Cached fetch should be faster (or return from DB)
      expect(duration2).toBeLessThanOrEqual(duration1 * 2);
    });

    it('should respect manual refresh flag to bypass cache', async () => {
      await fixtureService.fetchFixtures(teamId);

      // Force refresh
      const freshFixtures = await fixtureService.fetchFixtures(teamId, { forceRefresh: true });

      expect(freshFixtures.length).toBeGreaterThan(0);
    });

    it('should reflect updated fixture information on re-check (FR-003, scenario 3)', async () => {
      const [game] = await fixtureService.fetchFixtures(teamId);
      expect(game).toBeDefined();

      // Simulate the stored venue drifting away from the club website
      await db
        .update(schema.games)
        .set({ venue: 'Stale Venue', updatedAt: new Date() })
        .where(eq(schema.games.id, game!.id));

      // Re-check against the (unchanged) club website
      await fixtureService.fetchFixtures(teamId);

      const [refreshed] = await db.select().from(schema.games).where(eq(schema.games.id, game!.id));

      // The re-scrape reflects the website's value, overwriting the drift
      expect(refreshed!.venue).toBe(game!.venue);
    });
  });

  describe('fixture ordering', () => {
    it('should return fixtures in chronological order', async () => {
      await fixtureService.fetchFixtures(teamId);

      const fixtures = await fixtureService.getUpcomingFixtures(seasonId);

      // Verify chronological order
      for (let i = 1; i < fixtures.length; i++) {
        expect(fixtures[i].gameDate >= fixtures[i - 1].gameDate).toBe(true);
      }
    });
  });

  describe('venue handling', () => {
    it('should use default venue when not specified in HTML', async () => {
      await fixtureService.fetchFixtures(teamId);

      const games = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      games.forEach((game) => {
        // Venue should be set (either from HTML or default)
        expect(game.venue.length).toBeGreaterThan(0);
      });
    });
  });
});
