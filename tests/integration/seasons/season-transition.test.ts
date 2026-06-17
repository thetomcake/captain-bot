import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '#src/database/schema.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { IFixtureScraper, Fixture } from '#src/scraping/fixture-scraper.js';
import { normaliseOurFixtures } from '#src/scraping/fixture-normaliser.js';
import { reloadEnv } from '#src/config/env.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';
import { createTestDatabase, TestDatabase } from '../../helpers/test-database.js';

/**
 * Scraper stub returning a fixed, fully-controlled RAW fixture list (parser shape) so the test can
 * simulate the club website dropping every old fixture and showing new ones. The service normalises
 * these to our-team fixtures, so each row features our team ("Test Team") with Old/New opponents.
 */
class StubScraper implements IFixtureScraper {
  constructor(public fixtures: Fixture[]) {}
  async fetchHtml(_url: string): Promise<string> {
    return 'stub';
  }
  parseFixtures(_html: string): Fixture[] {
    return this.fixtures;
  }
}

const TEAM = 'Test Team';
const FIXED = new Date(2026, 0, 1); // deterministic year anchor for the normaliser

function rawHome(month: number, day: number, opponent: string): Fixture {
  return { month, day, time: '19:00', venue: 'Arena A', status: 'upcoming', homeTeam: TEAM, awayTeam: opponent };
}

// RAW parser-shape fixtures fed through the StubScraper + sync path (normalised by the service).
const SEASON_ONE: Fixture[] = [rawHome(1, 10, 'Old Town FC'), rawHome(1, 17, 'Old City')];
const SEASON_TWO: Fixture[] = [rawHome(9, 5, 'New United'), rawHome(9, 12, 'New Rovers')];

// Normalised (our-team) forms for the direct shouldCreateNewSeason calls (which now take OurFixture[]).
const OUR_ONE = normaliseOurFixtures(SEASON_ONE, TEAM, FIXED).fixtures;
const OUR_TWO = normaliseOurFixtures(SEASON_TWO, TEAM, FIXED).fixtures;

describe('Season Transition (US5, FR-004/FR-005, SC-006/SC-007)', () => {
  let test: TestDatabase;
  let seasonService: SeasonService;
  let teamId: number;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ teamName: TEAM }));
    reloadEnv();

    test = createTestDatabase();

    const [team] = await test.db
      .insert(schema.teams)
      .values({ name: TEAM, clubUrl: 'https://example.com/club/', whatsappGroupId: null })
      .returning();
    teamId = team!.id;

    seasonService = new SeasonService(test.db);
  });

  afterEach(() => {
    test.close();
  });

  function fixtureService(fixtures: Fixture[]): FixtureService {
    return new FixtureService(test.db, seasonService, new StubScraper(fixtures), () => FIXED);
  }

  /** Seed season 1 with fixtures plus a poll and a stat record for retention checks. */
  async function seedSeasonOne(): Promise<{ seasonId: number; gameId: number }> {
    await fixtureService(SEASON_ONE).syncFixtures(teamId);

    const season = await seasonService.getCurrentSeason(teamId);
    const [game] = await test.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.seasonId, season!.id))
      .limit(1);

    const [user] = await test.db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'user-1', displayName: 'Player One' })
      .returning();

    await test.db.insert(schema.polls).values({
      gameId: game!.id,
      pollMessageId: 'poll-msg-1',
      groupId: 'group-1',
      messageSecret: 'secret-1',
      postedAt: new Date(),
      pollQuestion: 'Available?',
      pollOptions: ['Yes', 'No', 'Maybe'],
    });

    await test.db.insert(schema.statRecords).values({
      gameId: game!.id,
      userId: user!.id,
      goals: 2,
      assists: 1,
      confidenceScore: 90,
    });

    return { seasonId: season!.id, gameId: game!.id };
  }

  describe('shouldCreateNewSeason', () => {
    it('returns false on the very first scrape (no previously scraped fixtures)', async () => {
      const should = await seasonService.shouldCreateNewSeason(teamId, OUR_ONE);
      expect(should).toBe(false);
    });

    it('returns false when some previously scraped fixtures still appear', async () => {
      await seedSeasonOne();
      // Re-scrape that still contains one of the original fixtures
      const overlapping = [OUR_ONE[0]!, OUR_TWO[0]!];
      const should = await seasonService.shouldCreateNewSeason(teamId, overlapping);
      expect(should).toBe(false);
    });

    it('returns false on an empty scrape (transient — do not transition)', async () => {
      await seedSeasonOne();
      const should = await seasonService.shouldCreateNewSeason(teamId, []);
      expect(should).toBe(false);
    });

    it('returns true when every previously scraped fixture has disappeared (FR-005)', async () => {
      await seedSeasonOne();
      const should = await seasonService.shouldCreateNewSeason(teamId, OUR_TWO);
      expect(should).toBe(true);
    });
  });

  describe('sync triggers a transition and preserves history', () => {
    it('creates a new season, populates it, and retains the previous season intact', async () => {
      const { seasonId: oldSeasonId, gameId: oldGameId } = await seedSeasonOne();

      // Re-scrape: club site has dropped all old fixtures and shows new ones
      const result = await fixtureService(SEASON_TWO).syncFixtures(teamId);

      expect(result.seasonTransition).toBe(true);

      // Two seasons now exist
      const seasons = await seasonService.getSeasons(teamId);
      expect(seasons.length).toBe(2);

      const oldSeason = seasons.find((s) => s.id === oldSeasonId)!;
      const newSeason = seasons.find((s) => s.id !== oldSeasonId)!;

      // Old season ended and preserved; new season is current (SC-006)
      expect(oldSeason.isCurrent).toBe(false);
      expect(oldSeason.endDate).toBeInstanceOf(Date);
      expect(newSeason.isCurrent).toBe(true);
      expect(newSeason.seasonNumber).toBe(oldSeason.seasonNumber + 1);

      // New fixtures populate the new season (no cross-contamination)
      const newGames = await test.db
        .select()
        .from(schema.games)
        .where(eq(schema.games.seasonId, newSeason.id));
      expect(newGames.length).toBe(SEASON_TWO.length);
      expect(newGames.map((g) => g.opponent).sort()).toEqual(['New Rovers', 'New United']);

      // Previous-season game, poll, and stat all retained (SC-007)
      const oldGames = await test.db
        .select()
        .from(schema.games)
        .where(eq(schema.games.seasonId, oldSeasonId));
      expect(oldGames.length).toBe(SEASON_ONE.length);

      const polls = await test.db
        .select()
        .from(schema.polls)
        .where(eq(schema.polls.gameId, oldGameId));
      expect(polls.length).toBe(1);

      const stats = await test.db
        .select()
        .from(schema.statRecords)
        .where(eq(schema.statRecords.gameId, oldGameId));
      expect(stats.length).toBe(1);
      expect(stats[0]!.goals).toBe(2);
    });

    it('does not transition on a normal re-sync with unchanged fixtures', async () => {
      const { seasonId } = await seedSeasonOne();

      const result = await fixtureService(SEASON_ONE).syncFixtures(teamId);

      expect(result.seasonTransition).toBe(false);
      const seasons = await seasonService.getSeasons(teamId);
      expect(seasons.length).toBe(1);
      const current = await seasonService.getCurrentSeason(teamId);
      expect(current!.id).toBe(seasonId);
    });
  });
});
