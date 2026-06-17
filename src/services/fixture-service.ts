import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and, asc, gte } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { Game, GameStatus, Season } from '../types/entities.js';
import { SeasonService } from './season-service.js';
import { IFixtureScraper, DefaultFixtureScraper } from '../scraping/fixture-scraper.js';
import { normaliseOurFixtures, OurFixture } from '../scraping/fixture-normaliser.js';
import { ManvfatSession } from '../scraping/manvfat-session.js';
import { getCredentialKey, getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

type Team = typeof schema.teams.$inferSelect;

export interface FixtureChange {
  type: 'added' | 'updated' | 'removed';
  game: Game;
  changes?: Partial<Game>;
}

export interface FixtureChanges {
  added: Game[];
  updated: FixtureChange[];
  removed: Game[];
  rescheduled: FixtureChange[];
}

export interface SyncResult {
  /** Fixtures stored for the (possibly new) current season after the sync. */
  games: Game[];
  /** True when this sync detected a season transition and created a new season (FR-005). */
  seasonTransition: boolean;
  /** The new season's number when a transition occurred. */
  newSeasonNumber?: number;
}

export class FixtureService {
  /**
   * An explicitly injected scraper (tests use the service-boundary mocks). When present it is
   * used verbatim and none of the MAN v FAT auth path runs. When absent, each operation builds
   * a team-scoped {@link DefaultFixtureScraper} carrying that team's credentials + cookie
   * (feature 005).
   */
  private injectedScraper?: IFixtureScraper;

  /**
   * Clock seam. Year assignment (FR-002) and the future-date selection guard (FR-008) are
   * time-relative, so "now" is injectable — production uses the real clock; tests pass a fixed
   * value to make the year-boundary and score-lag scenarios deterministic against static fixtures.
   */
  private readonly now: () => Date;

  constructor(
    private db: BetterSQLite3Database<typeof schema>,
    private seasonService: SeasonService,
    scraper?: IFixtureScraper,
    now: () => Date = () => new Date()
  ) {
    this.injectedScraper = scraper;
    this.now = now;
  }

  /**
   * Reduce a freshly scraped league list to our-team fixtures (derived opponent + ISO date),
   * filtering by the configured team name and anchoring the year to "now" (FR-001/002/003). When
   * the scrape held league fixtures but none feature our team, logs the FR-005 likely-mismatch
   * signal (counts only — never credentials/cookies) so the operator can spot a `TEAM_NAME`
   * misconfiguration; the caller then proceeds with an empty set ("no confirmed next fixture").
   */
  private normaliseScraped(scraped: ReturnType<IFixtureScraper['parseFixtures']>): OurFixture[] {
    const teamName = getEnv().teamName;
    const { fixtures, leagueFixturesButNoneOurs } = normaliseOurFixtures(
      scraped,
      teamName,
      this.now()
    );

    if (leagueFixturesButNoneOurs) {
      logger.warn(
        'Scraped league fixtures but none feature our team — likely TEAM_NAME mismatch; ' +
          'no confirmed next fixture.',
        { scraped: scraped.length, matched: 0, teamName }
      );
    }

    return fixtures;
  }

  /**
   * Resolve the scraper for an operation. With an injected scraper (tests) it is returned
   * as-is. Otherwise a team-scoped {@link DefaultFixtureScraper} is built: it wraps a
   * {@link ManvfatSession} seeded from the team's stored credentials + cookie, with a
   * `persistCookie` callback that writes the refreshed encrypted jar back to
   * `teams.manvfat_cookie` (FR-003). Constructing the session throws `ConfigError` when the
   * team has no credentials, or when `MANVFAT_CREDENTIAL_KEY` is missing/invalid (FR-009).
   */
  private getScraper(team: Team): IFixtureScraper {
    if (this.injectedScraper) {
      return this.injectedScraper;
    }

    const key = getCredentialKey();
    const session = new ManvfatSession({
      team,
      key,
      persistCookie: async (teamId, encryptedJarBlob) => {
        await this.db
          .update(schema.teams)
          .set({ manvfatCookie: encryptedJarBlob, updatedAt: new Date() })
          .where(eq(schema.teams.id, teamId));
      },
    });

    return new DefaultFixtureScraper(session);
  }

  /**
   * Fetch fixtures from club URL and store in database
   * @param teamId - Team ID
   * @param options - Fetch options
   * @returns Array of stored games
   */
  async fetchFixtures(teamId: number, _options: { forceRefresh?: boolean } = {}): Promise<Game[]> {
    const team = await this.getTeam(teamId);

    // Get or create current season
    const season = await this.seasonService.getOrCreateCurrentSeason(teamId);

    // Scrape fixtures from club URL using the team-scoped (or injected) scraper
    const scraper = this.getScraper(team);
    const html = await scraper.fetchHtml(team.clubUrl);
    const ourFixtures = this.normaliseScraped(scraper.parseFixtures(html));

    return this.persistScrapedFixtures(team, season, ourFixtures);
  }

  /**
   * Persist a set of already-scraped fixtures into the given season (insert new,
   * update changed venue/status), then advance the season start date.
   */
  private async persistScrapedFixtures(
    team: Team,
    season: Season,
    scrapedFixtures: {
      date: string;
      time: string;
      opponent: string;
      venue: string;
      status: GameStatus;
    }[]
  ): Promise<Game[]> {
    // Convert scraped fixtures to games and store
    const games: Game[] = [];

    for (const fixture of scrapedFixtures) {
      // Parse date and time
      const gameDate = this.parseGameDateTime(fixture.date, fixture.time);

      // Check if game already exists
      const [existing] = await this.db
        .select()
        .from(schema.games)
        .where(
          and(
            eq(schema.games.seasonId, season.id),
            eq(schema.games.gameDate, gameDate),
            eq(schema.games.opponent, fixture.opponent)
          )
        )
        .limit(1);

      if (existing) {
        // Update if changed
        if (existing.venue !== fixture.venue || existing.status !== fixture.status) {
          await this.db
            .update(schema.games)
            .set({
              venue: fixture.venue,
              status: fixture.status,
              updatedAt: new Date(),
            })
            .where(eq(schema.games.id, existing.id));

          games.push({ ...existing, venue: fixture.venue, status: fixture.status });
        } else {
          games.push(existing);
        }
      } else {
        // Insert new game
        const [newGame] = await this.db
          .insert(schema.games)
          .values({
            seasonId: season.id,
            gameDate,
            opponent: fixture.opponent,
            venue: fixture.venue,
            status: fixture.status,
            scrapedUrl: team.clubUrl,
          })
          .returning();

        if (newGame) {
          games.push(newGame);
        }
      }
    }

    // Update season start date if needed
    if (games.length > 0) {
      const earliestGame = games.reduce((earliest, game) =>
        game.gameDate < earliest.gameDate ? game : earliest
      );
      await this.seasonService.setStartDate(season.id, earliestGame.gameDate);
    }

    return games;
  }

  /**
   * Sync fixtures from the club website, detecting a season transition along the
   * way (FR-005). Scrapes once, and if every previously scraped fixture has
   * disappeared, ends the current season and creates the next before persisting
   * the new fixtures into it — previous-season data is left untouched (SC-006/SC-007).
   */
  async syncFixtures(teamId: number): Promise<SyncResult> {
    const team = await this.getTeam(teamId);

    const scraper = this.getScraper(team);
    const html = await scraper.fetchHtml(team.clubUrl);
    const scrapedFixtures = this.normaliseScraped(scraper.parseFixtures(html));

    const seasonTransition = await this.seasonService.shouldCreateNewSeason(
      teamId,
      scrapedFixtures
    );

    let newSeasonNumber: number | undefined;
    if (seasonTransition) {
      const newSeason = await this.seasonService.createNewSeason(teamId);
      newSeasonNumber = newSeason.seasonNumber;
      logger.info(
        `Season transition detected — old fixtures gone, created season ${newSeason.seasonNumber}`,
        { teamId }
      );
    }

    // Re-resolve the current season (the new one when a transition just happened).
    const season = await this.seasonService.getOrCreateCurrentSeason(teamId);
    const games = await this.persistScrapedFixtures(team, season, scrapedFixtures);

    logger.info('Fixtures checked', {
      teamId,
      scraped: scrapedFixtures.length,
      persisted: games.length,
      seasonTransition,
    });

    return { games, seasonTransition, newSeasonNumber };
  }

  private async getTeam(teamId: number): Promise<Team> {
    const [team] = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .limit(1);

    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    return team;
  }

  /**
   * Get upcoming fixtures for a season
   * @param seasonId - Season ID
   * @returns Array of upcoming games
   */
  async getUpcomingFixtures(seasonId: number, now: Date = this.now()): Promise<Game[]> {
    return await this.db
      .select()
      .from(schema.games)
      .where(
        and(
          eq(schema.games.seasonId, seasonId),
          eq(schema.games.status, 'upcoming'),
          gte(schema.games.gameDate, now)
        )
      )
      .orderBy(asc(schema.games.gameDate));
  }

  /**
   * Get all fixtures for a season
   * @param seasonId - Season ID
   * @param status - Optional status filter
   * @returns Array of games
   */
  async getFixtures(seasonId: number, status?: GameStatus): Promise<Game[]> {
    const conditions = [eq(schema.games.seasonId, seasonId)];

    if (status) {
      conditions.push(eq(schema.games.status, status));
    }

    return await this.db
      .select()
      .from(schema.games)
      .where(and(...conditions))
      .orderBy(asc(schema.games.gameDate));
  }

  /**
   * Get a specific game by ID
   * @param gameId - Game ID
   * @returns Game or null if not found
   */
  async getGame(gameId: number): Promise<Game | null> {
    const [game] = await this.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.id, gameId))
      .limit(1);

    return game || null;
  }

  /**
   * Detect fixture changes (for FR-021)
   * @param teamId - Team ID
   * @returns Fixture changes
   */
  async detectFixtureChanges(teamId: number): Promise<FixtureChanges> {
    // Get current season
    const season = await this.seasonService.getCurrentSeason(teamId);
    if (!season) {
      return { added: [], updated: [], removed: [], rescheduled: [] };
    }

    // Get existing fixtures
    const existingFixtures = await this.getFixtures(season.id);

    // Get team
    const [team] = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .limit(1);

    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    // Scrape current fixtures using the team-scoped (or injected) scraper, reduced to our team.
    const scraper = this.getScraper(team);
    const html = await scraper.fetchHtml(team.clubUrl);
    const scrapedFixtures = this.normaliseScraped(scraper.parseFixtures(html));

    const changes: FixtureChanges = {
      added: [],
      updated: [],
      removed: [],
      rescheduled: [],
    };

    // Detect added and updated fixtures
    for (const scraped of scrapedFixtures) {
      const gameDate = this.parseGameDateTime(scraped.date, scraped.time);

      const existing = existingFixtures.find(
        (f: Game) =>
          f.opponent === scraped.opponent &&
          Math.abs(f.gameDate.getTime() - gameDate.getTime()) < 86400000 * 7 // Within 7 days
      );

      if (!existing) {
        // New fixture
        changes.added.push({
          id: 0, // Placeholder
          seasonId: season.id,
          gameDate,
          opponent: scraped.opponent,
          venue: scraped.venue,
          status: scraped.status,
          scrapedUrl: team.clubUrl,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else if (
        existing.gameDate.getTime() !== gameDate.getTime() ||
        existing.venue !== scraped.venue
      ) {
        // Rescheduled fixture
        changes.rescheduled.push({
          type: 'updated',
          game: existing,
          changes: {
            gameDate,
            venue: scraped.venue,
          },
        });
      }
    }

    // Detect removed fixtures (fixtures that no longer appear)
    const scrapedOpponents = new Set(scrapedFixtures.map((f) => f.opponent));
    const upcomingFixtures = existingFixtures.filter((f) => f.status === 'upcoming');

    for (const existing of upcomingFixtures) {
      if (!scrapedOpponents.has(existing.opponent)) {
        changes.removed.push(existing);
      }
    }

    return changes;
  }

  /**
   * Update game status
   * @param gameId - Game ID
   * @param status - New status
   */
  async updateGameStatus(gameId: number, status: GameStatus): Promise<void> {
    await this.db
      .update(schema.games)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.games.id, gameId));
  }

  /**
   * Parse game date and time into a Date object
   * @param dateStr - ISO date string (YYYY-MM-DD)
   * @param timeStr - Time string (HH:MM)
   * @returns Date object
   */
  private parseGameDateTime(dateStr: string, timeStr: string): Date {
    const dateParts = dateStr.split('-').map(Number);
    const timeParts = timeStr.split(':').map(Number);

    const year = dateParts[0] || 0;
    const month = dateParts[1] || 1;
    const day = dateParts[2] || 1;
    const hour = timeParts[0] || 0;
    const minute = timeParts[1] || 0;

    // Create date in local timezone (UK timezone default)
    return new Date(year, month - 1, day, hour, minute);
  }
}
