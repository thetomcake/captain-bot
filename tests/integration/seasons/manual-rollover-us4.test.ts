import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '#src/database/schema.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { IFixtureScraper, Fixture } from '#src/scraping/fixture-scraper.js';
import { reloadEnv } from '#src/config/env.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';
import { createTestDatabase, TestDatabase } from '../../helpers/test-database.js';

/**
 * US4 (spec 006) — manual season rollover. After `endSeason`, the next fetch lazily creates the next
 * season via `getOrCreateCurrentSeason` and stores new fixtures there, leaving the previous season
 * (games + stats) untouched (AS1/AS2/SC-008/FR-012). With the automatic season-transition detector
 * retired (FR-011), repeated fetches NEVER roll over on their own — even when every fixture changes
 * (AS6/SC-009). Service-boundary test with a controlled scraper + fixed clock.
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
  return {
    month,
    day,
    time: '19:00',
    venue: 'Arena A',
    status: 'upcoming',
    homeTeam: TEAM,
    awayTeam: opponent,
  };
}

const SEASON_ONE: Fixture[] = [rawHome(1, 10, 'Old Town FC'), rawHome(1, 17, 'Old City')];
const SEASON_TWO: Fixture[] = [rawHome(9, 5, 'New United'), rawHome(9, 12, 'New Rovers')];

describe('US4 — manual season rollover', () => {
  let test: TestDatabase;
  let seasonService: SeasonService;
  let teamId: number;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ teamName: TEAM }));
    reloadEnv();

    test = createTestDatabase();
    const [team] = await test.db
      .insert(schema.teams)
      .values({ name: TEAM, clubUrl: 'https://example.com/club/' })
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

  it('endSeason marks the season ended and preserves its games + stats (AS1/SC-008)', async () => {
    await fixtureService(SEASON_ONE).fetchFixtures(teamId);
    const season = (await seasonService.getCurrentSeason(teamId))!;
    const [game] = await test.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.seasonId, season.id))
      .limit(1);

    const [user] = await test.db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'user-1', displayName: 'Player One' })
      .returning();
    await test.db.insert(schema.statRecords).values({
      gameId: game!.id,
      userId: user!.id,
      goals: 2,
      assists: 1,
      confidenceScore: 90,
    });

    await seasonService.endSeason(season.id);

    const ended = (await seasonService.getSeason(season.id))!;
    expect(ended.isCurrent).toBe(false);
    expect(ended.endDate).toBeInstanceOf(Date);

    // Games + stats survive the rollover untouched (SC-008).
    const games = await test.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.seasonId, season.id));
    expect(games.length).toBe(SEASON_ONE.length);
    const stats = await test.db
      .select()
      .from(schema.statRecords)
      .where(eq(schema.statRecords.gameId, game!.id));
    expect(stats.length).toBe(1);
    expect(stats[0]!.goals).toBe(2);
  });

  it('the next fetch lazily creates the next season and stores new fixtures there, previous untouched (AS2/FR-012)', async () => {
    await fixtureService(SEASON_ONE).fetchFixtures(teamId);
    const oldSeason = (await seasonService.getCurrentSeason(teamId))!;

    await seasonService.endSeason(oldSeason.id);

    // Next fetch — no current season, so getOrCreateCurrentSeason makes season N+1.
    await fixtureService(SEASON_TWO).fetchFixtures(teamId);

    const seasons = await seasonService.getSeasons(teamId);
    expect(seasons.length).toBe(2);
    const newSeason = seasons.find((s) => s.id !== oldSeason.id)!;
    expect(newSeason.isCurrent).toBe(true);
    expect(newSeason.seasonNumber).toBe(oldSeason.seasonNumber + 1);

    // New fixtures land in the new season; the old season is unchanged.
    const newGames = await test.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.seasonId, newSeason.id));
    expect(newGames.map((g) => g.opponent).sort()).toEqual(['New Rovers', 'New United']);

    const oldGames = await test.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.seasonId, oldSeason.id));
    expect(oldGames.map((g) => g.opponent).sort()).toEqual(['Old City', 'Old Town FC']);
  });

  it('repeated fetches NEVER trigger an automatic season transition, even when every fixture changes (AS6/SC-009)', async () => {
    await fixtureService(SEASON_ONE).fetchFixtures(teamId);
    const seasonId = (await seasonService.getCurrentSeason(teamId))!.id;

    // Club site drops all old fixtures and shows a completely fresh set — pre-FR-011 this would have
    // auto-transitioned. It must NOT now: still one season, the same current one.
    await fixtureService(SEASON_TWO).fetchFixtures(teamId);

    const seasons = await seasonService.getSeasons(teamId);
    expect(seasons.length).toBe(1);
    const current = (await seasonService.getCurrentSeason(teamId))!;
    expect(current.id).toBe(seasonId);
  });
});
