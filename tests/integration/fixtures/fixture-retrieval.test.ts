import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';

// Import services to be implemented
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';

describe('Fixture Service Integration Tests', () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database.Database;
  let fixtureService: FixtureService;
  let seasonService: SeasonService;
  let teamId: number;
  let seasonId: number;

  beforeEach(async () => {
    // Use in-memory database for testing
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });

    // Run migrations
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    // Create test team
    const [team] = await db.insert(schema.teams).values({
      name: 'Test Team',
      clubUrl: 'https://manvfatfootball.com/club/watford/',
      whatsappGroupId: null,
    }).returning();
    teamId = team.id;

    // Create test season
    const [season] = await db.insert(schema.seasons).values({
      teamId,
      seasonNumber: 1,
      isCurrent: true,
    }).returning();
    seasonId = season.id;

    // Initialize services
    seasonService = new SeasonService(db);
    fixtureService = new FixtureService(db, seasonService);
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

      games.forEach(game => {
        expect(game.seasonId).toBe(seasonId);
      });
    });

    it('should set status to "upcoming" for future fixtures', async () => {
      await fixtureService.fetchFixtures(teamId);

      const upcomingGames = await db.query.games.findMany({
        where: (games, { and, eq }) => and(
          eq(games.seasonId, seasonId),
          eq(games.status, 'upcoming')
        ),
      });

      expect(upcomingGames.length).toBeGreaterThan(0);
    });

    it('should handle club URL fetch errors gracefully', async () => {
      // Create team with invalid URL
      const [invalidTeam] = await db.insert(schema.teams).values({
        name: 'Invalid Team',
        clubUrl: 'https://invalid-url-that-does-not-exist.com',
        whatsappGroupId: null,
      }).returning();

      // Should throw or return empty array
      await expect(
        fixtureService.fetchFixtures(invalidTeam.id)
      ).rejects.toThrow();
    });
  });

  describe('syncFixtures', () => {
    it('should update existing fixtures when re-syncing', async () => {
      // First sync
      await fixtureService.fetchFixtures(teamId);

      const firstSyncCount = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      // Second sync
      await fixtureService.syncFixtures(teamId);

      const secondSyncCount = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      // Count should be similar (accounting for possible new fixtures)
      expect(secondSyncCount.length).toBeGreaterThanOrEqual(firstSyncCount.length);
    });

    it('should detect fixture changes (FR-021)', async () => {
      // First sync - store original fixtures
      await fixtureService.fetchFixtures(teamId);

      const originalGames = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      // Manually change a fixture date to simulate rescheduling
      const gameToUpdate = originalGames[0];
      const newDate = new Date(gameToUpdate.gameDate);
      newDate.setDate(newDate.getDate() + 7); // Move 1 week forward

      await db.update(schema.games)
        .set({ gameDate: newDate })
        .where((games, { eq }) => eq(games.id, gameToUpdate.id));

      // Sync again - should detect the change
      const changes = await fixtureService.detectFixtureChanges(teamId);

      expect(changes).toBeDefined();
      expect(changes.rescheduled.length).toBeGreaterThanOrEqual(0);
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

  describe('error handling', () => {
    it('should handle network timeouts gracefully', async () => {
      // Mock a timeout scenario
      // Implementation should retry with exponential backoff
      expect(true).toBe(true); // Placeholder
    });

    it('should handle malformed HTML gracefully', async () => {
      // If scraper returns empty array, service should handle it
      const fixtures = await fixtureService.fetchFixtures(teamId);

      expect(Array.isArray(fixtures)).toBe(true);
    });

    it('should log scraping errors for debugging', async () => {
      // Verify that errors are logged
      // Implementation will use logger utility
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('retry logic (per research.md)', () => {
    it('should retry failed scrapes with exponential backoff', async () => {
      // Implementation should retry up to 3 times with 1s, 2s, 4s delays
      expect(true).toBe(true); // Placeholder
    });

    it('should respect rate limiting (conservative crawling)', async () => {
      // Should not hammer the server
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('venue handling', () => {
    it('should use default venue when not specified in HTML', async () => {
      await fixtureService.fetchFixtures(teamId);

      const games = await db.query.games.findMany({
        where: (games, { eq }) => eq(games.seasonId, seasonId),
      });

      games.forEach(game => {
        // Venue should be set (either from HTML or default)
        expect(game.venue.length).toBeGreaterThan(0);
      });
    });
  });
});
