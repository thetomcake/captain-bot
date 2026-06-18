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
   * Fetch the club page for a team and reduce it to our-team fixtures: resolve the (injected or
   * team-scoped) scraper, fetch the HTML, parse it, and normalise to {@link OurFixture}s (deriving
   * opponent + ISO date and emitting the FR-005 mismatch log). The single load step behind
   * `fetchFixtures`.
   */
  private async scrapeOurFixtures(team: Team): Promise<OurFixture[]> {
    const scraper = this.getScraper(team);
    const html = await scraper.fetchHtml(team.clubUrl);
    return this.normaliseScraped(scraper.parseFixtures(html));
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
   * Fetch our-team fixtures from the club URL and store them in the current season (FR-003/FR-007).
   *
   * The single load path used by every caller (`init`, `sync`, on-demand poll resolution). It
   * lazily resolves the current season via {@link SeasonService.getOrCreateCurrentSeason} — so after
   * a manual `end-of-season` the next fetch starts the next season (FR-012) — then scrapes,
   * normalises to our-team fixtures, and upserts them. Season rollover is **manual only** (FR-011):
   * this never transitions seasons on its own, even when every previously-seen fixture has changed.
   *
   * @param teamId - Team ID
   * @returns Array of stored games for the current season
   */
  async fetchFixtures(teamId: number, _options: { forceRefresh?: boolean } = {}): Promise<Game[]> {
    const team = await this.getTeam(teamId);

    // Get or create current season (lazily starts the next season after a manual end-of-season).
    const season = await this.seasonService.getOrCreateCurrentSeason(teamId);

    // Scrape fixtures from club URL using the team-scoped (or injected) scraper
    const ourFixtures = await this.scrapeOurFixtures(team);

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
