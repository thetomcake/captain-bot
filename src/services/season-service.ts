import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and, desc } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { Season } from '../types/entities.js';
import { OurFixture } from '../scraping/fixture-normaliser.js';

export class SeasonService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Get current season for a team
   * @param teamId - Team ID
   * @returns Current season or null if none exists
   */
  async getCurrentSeason(teamId: number): Promise<Season | null> {
    const [season] = await this.db
      .select()
      .from(schema.seasons)
      .where(and(eq(schema.seasons.teamId, teamId), eq(schema.seasons.isCurrent, true)))
      .limit(1);

    return season || null;
  }

  /**
   * Get or create current season for a team
   * @param teamId - Team ID
   * @returns Current season (existing or newly created)
   */
  async getOrCreateCurrentSeason(teamId: number): Promise<Season> {
    // Check for existing current season
    const existing = await this.getCurrentSeason(teamId);
    if (existing) {
      return existing;
    }

    // Get the highest season number for this team
    const [lastSeason] = await this.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.teamId, teamId))
      .orderBy(desc(schema.seasons.seasonNumber))
      .limit(1);

    const newSeasonNumber = (lastSeason?.seasonNumber || 0) + 1;

    // Create new season
    const [newSeason] = await this.db
      .insert(schema.seasons)
      .values({
        teamId,
        seasonNumber: newSeasonNumber,
        isCurrent: true,
        startDate: null, // Will be set when first fixture is added
        endDate: null,
      })
      .returning();

    if (!newSeason) {
      throw new Error('Failed to create new season');
    }

    return newSeason;
  }

  /**
   * Get all seasons for a team
   * @param teamId - Team ID
   * @returns Array of seasons, ordered by season number descending
   */
  async getSeasons(teamId: number): Promise<Season[]> {
    return await this.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.teamId, teamId))
      .orderBy(desc(schema.seasons.seasonNumber));
  }

  /**
   * Get a specific season by ID
   * @param seasonId - Season ID
   * @returns Season or null if not found
   */
  async getSeason(seasonId: number): Promise<Season | null> {
    const [season] = await this.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId))
      .limit(1);

    return season || null;
  }

  /**
   * Mark a season as not current and optionally set end date
   * @param seasonId - Season ID
   * @param endDate - Optional end date
   */
  async endSeason(seasonId: number, endDate?: Date): Promise<void> {
    await this.db
      .update(schema.seasons)
      .set({
        isCurrent: false,
        endDate: endDate || new Date(),
      })
      .where(eq(schema.seasons.id, seasonId));
  }

  /**
   * Create a new season (typically called when season transition detected)
   * @param teamId - Team ID
   * @returns Newly created season
   */
  async createNewSeason(teamId: number): Promise<Season> {
    // End the current season first
    const currentSeason = await this.getCurrentSeason(teamId);
    if (currentSeason) {
      await this.endSeason(currentSeason.id);
    }

    // Get the highest season number for this team
    const [lastSeason] = await this.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.teamId, teamId))
      .orderBy(desc(schema.seasons.seasonNumber))
      .limit(1);

    const newSeasonNumber = (lastSeason?.seasonNumber || 0) + 1;

    // Create new season
    const [newSeason] = await this.db
      .insert(schema.seasons)
      .values({
        teamId,
        seasonNumber: newSeasonNumber,
        isCurrent: true,
        startDate: null,
        endDate: null,
      })
      .returning();

    if (!newSeason) {
      throw new Error('Failed to create new season');
    }

    return newSeason;
  }

  /**
   * Update season start date (when first fixture is added)
   * @param seasonId - Season ID
   * @param startDate - Start date
   */
  async setStartDate(seasonId: number, startDate: Date): Promise<void> {
    const season = await this.getSeason(seasonId);
    if (!season) {
      throw new Error(`Season not found: ${seasonId}`);
    }

    // Only update if start date is not already set or is earlier than current
    if (!season.startDate || startDate < season.startDate) {
      await this.db
        .update(schema.seasons)
        .set({ startDate })
        .where(eq(schema.seasons.id, seasonId));
    }
  }

  /**
   * Detect whether a new season should be created (User Story 5, FR-005).
   *
   * Per the spec's settled rule (research §7): a transition happens when **all**
   * previously scraped fixtures have disappeared from the club website on a
   * re-scrape. "Previously scraped fixtures" = the current season's still-upcoming
   * games (past/completed fixtures naturally drop off the site, so including them
   * would force a false transition every sync).
   *
   * Guards against false positives (SC-006): returns false when there is no
   * current season, when nothing was previously scraped, or when the latest
   * scrape is empty (a transient/off-season blip is not a transition — a new
   * season only begins once new fixtures actually appear).
   *
   * @param teamId - Team ID
   * @param scrapedFixtures - Fixtures from the latest scrape
   * @returns True iff every previously scraped (upcoming) fixture is absent from the latest scrape
   */
  async shouldCreateNewSeason(teamId: number, scrapedFixtures: OurFixture[]): Promise<boolean> {
    // No new fixtures → off-season/transient blip, never a transition.
    if (scrapedFixtures.length === 0) {
      return false;
    }

    const current = await this.getCurrentSeason(teamId);
    if (!current) {
      return false;
    }

    // Previously scraped fixtures = current season's still-upcoming games.
    const previousGames = await this.db
      .select()
      .from(schema.games)
      .where(and(eq(schema.games.seasonId, current.id), eq(schema.games.status, 'upcoming')));

    if (previousGames.length === 0) {
      return false;
    }

    // A new season iff NONE of the previously scraped fixtures still appear.
    const scrapedKeys = new Set(scrapedFixtures.map((f) => this.fixtureKey(f.opponent, f.date)));
    const anyStillPresent = previousGames.some((g) =>
      scrapedKeys.has(this.fixtureKey(g.opponent, this.toDateKey(g.gameDate)))
    );

    return !anyStillPresent;
  }

  /** Stable identity for a fixture across scrape/stored forms: opponent + calendar date. */
  private fixtureKey(opponent: string, isoDate: string): string {
    return `${opponent.trim().toLowerCase()}|${isoDate}`;
  }

  /** Local YYYY-MM-DD for a stored game date (mirrors the scraper's local-date parsing). */
  private toDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
