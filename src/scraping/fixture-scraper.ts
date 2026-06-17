import axios from 'axios';
import * as cheerio from 'cheerio';
import { withRetry } from '../utils/retry.js';
import { AuthError } from '../utils/errors.js';
import { enqueueRequest } from './request-queue.js';
import type { IManvfatSession } from './manvfat-session.js';

/**
 * A single league fixture as faithfully read from the club page (spec 006, contract C1).
 *
 * The parser reports only directly-observable facts. It does NOT compute the calendar year and
 * does NOT derive the opponent — those interpretations belong to the normaliser
 * (`fixture-normaliser.ts`, C2), which has the team name and an anchor "today". Accordingly there
 * is no `date` and no `opponent` here: just the week's raw `month`/`day`, the faithful
 * `homeTeam`/`awayTeam`, and the `-`/numeric scores.
 */
export interface Fixture {
  month: number; // 1-12, from the week header
  day: number; // 1-31, from the week header
  time: string; // HH:MM format
  venue: string;
  status: 'upcoming' | 'completed' | 'cancelled';
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
}

/** Month name (lower-cased) -> 1-12. */
const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/**
 * Parse a week header into its raw month + day — no year (contract C1, research §2).
 *
 * The week headers ("Week 7 - June 29th") carry no year, and the parser MUST NOT guess one from
 * the current month (that was the FR-002 bug). It is a pure function of the header text only; the
 * normaliser assigns the calendar year from page order anchored to today.
 *
 * @param weekText - Text like "Week 7 - June 29th"
 * @returns `{ month, day }` with month in 1-12
 */
export function parseWeekDate(weekText: string): { month: number; day: number } {
  const dateMatch = weekText.match(/Week\s+\d+\s+-\s+(\w+)\s+(\d+)(?:st|nd|rd|th)/i);

  if (!dateMatch) {
    throw new Error(`Unable to parse date from: ${weekText}`);
  }

  const monthName = dateMatch[1];
  const dayText = dateMatch[2];

  if (!monthName || !dayText) {
    throw new Error(`Invalid date format: ${weekText}`);
  }

  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) {
    throw new Error(`Unknown month: ${monthName}`);
  }

  return { month, day: parseInt(dayText, 10) };
}

/**
 * Scrape fixtures from MAN v FAT club page HTML (faithful HTML -> rows parser, contract C1).
 *
 * Returns one row per league fixture with the week's `month`/`day`, the faithful
 * `homeTeam`/`awayTeam`, `-`/numeric scores, `time`, and `status` (`completed` iff both scores are
 * numeric, else `upcoming`). It does NOT filter by team, derive the opponent, or assign a year —
 * those are the normaliser's job (`normaliseOurFixtures`).
 *
 * @param html - HTML content from club page
 */
export function scrapeFixtures(html: string): Fixture[] {
  const $ = cheerio.load(html);
  const fixtures: Fixture[] = [];

  // Find all week sections (each has a week header + fixture table)
  $('.group-header.white').each((_, headerElement) => {
    const weekText = $(headerElement).text().trim();

    // Skip if not a valid week header
    if (!weekText.includes('Week')) {
      return;
    }

    try {
      const { month, day } = parseWeekDate(weekText);

      // Find the fixture table following this header
      const section = $(headerElement).parent().parent();
      const table = section.find('table.fixture-table').first();

      // Process each fixture row
      table.find('tr.no-highlight').each((_, rowElement) => {
        const row = $(rowElement);

        // Skip if this is a "Fixtures to be confirmed" row
        const subtitleCell = row.find('td.subtitle');
        if (subtitleCell.length > 0) {
          return; // Skip TBD fixtures
        }

        // Extract time from game-week-no cell
        const timeCell = row.find('td.game-week-no').first();
        if (timeCell.length === 0) {
          return; // Skip rows without time (headers, etc.)
        }

        const timeCellHtml = timeCell.html();
        if (!timeCellHtml) {
          return;
        }

        // Time is before the <br> tag: "19:00<br>League"
        const timeParts = timeCellHtml.split('<br>');
        const time = timeParts[0]?.trim() || '';

        if (!time) {
          return;
        }
        if (!time.match(/^\d{2}:\d{2}$/)) {
          return; // Skip if time format is invalid
        }

        // Extract team names
        const teamCells = row.find('td.team-name');
        if (teamCells.length !== 2) {
          return; // Skip if not exactly 2 teams
        }

        const homeTeam = $(teamCells[0]).text().trim();
        const awayTeam = $(teamCells[1]).text().trim();

        if (!homeTeam || !awayTeam) {
          return; // Skip if team names are empty
        }

        // Extract scores (if present)
        const scoreCells = row.find('td.score');
        const homeScoreText = $(scoreCells[0]).text().trim();
        const awayScoreText = $(scoreCells[1]).text().trim();

        const homeScore = homeScoreText !== '-' ? parseInt(homeScoreText) : undefined;
        const awayScore = awayScoreText !== '-' ? parseInt(awayScoreText) : undefined;

        // Determine game status — completed iff BOTH scores are numeric (a "-" on either side
        // means the result is not yet published, so the game is still "upcoming"/unplayed.
        let status: Fixture['status'] = 'upcoming';
        if (homeScore !== undefined && awayScore !== undefined) {
          status = 'completed';
        }

        // Venue defaults to club venue (not specified in HTML). Opponent + year are NOT decided
        // here — the normaliser derives the opponent from home/away and assigns the calendar year.
        const venue = 'Club Venue';

        fixtures.push({
          month,
          day,
          time,
          venue,
          status,
          homeTeam,
          awayTeam,
          homeScore,
          awayScore,
        });
      });
    } catch (error) {
      // Skip weeks with unparseable dates
      console.warn(`Failed to parse week: ${weekText}`, error);
    }
  });

  return fixtures;
}

/**
 * Whether a fetched club page is from an authenticated session (feature 005, FR-005a).
 *
 * The signal is the WordPress `logged-in` class on `<body>` (research.md Finding 5) — NOT
 * the presence of fixtures. A logged-out page and an off-season authenticated page both render
 * empty fixture tables, so fixture count cannot discriminate them; the body class can. An
 * authenticated-but-empty page therefore returns `true` here and is treated as a valid empty
 * result by the recovery loop (no re-login, no error).
 */
export function isAuthenticated(html: string): boolean {
  return cheerio.load(html)('body').hasClass('logged-in');
}

/**
 * Fetch URL using shared retry utility
 */
async function fetchWithRetry(
  url: string,
  maxRetries = 3,
  baseDelay = 1000,
  cookieHeader?: string
): Promise<string> {
  return withRetry(
    async () => {
      // Each actual HTTP request — including every retry attempt — passes through the shared
      // per-host rate limiter (feature 005), so politeness is enforced at the request boundary
      // regardless of caller.
      return enqueueRequest(async () => {
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (compatible; CaptainStats/1.0)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        };
        // Attach the authenticated session cookie when one is supplied (feature 005). The
        // header value is never logged (FR-007).
        if (cookieHeader) {
          headers['Cookie'] = cookieHeader;
        }
        const response = await axios.get<string>(url, {
          headers,
          timeout: 10000,
        });
        return response.data;
      });
    },
    { maxRetries, baseDelay }
  );
}

/**
 * Scraper interface for dependency injection (test mocking)
 */
export interface IFixtureScraper {
  fetchHtml(url: string): Promise<string>;
  parseFixtures(html: string): Fixture[];
}

/**
 * Injectable page-fetch seam: GET `url` with the given cookie header, returning the HTML body.
 * The default issues the real rate-limited+retried axios GET; the recovery-loop unit tests
 * substitute a fake so the control flow can be exercised without a network call (feature 005 T015).
 */
export type FetchPageFn = (url: string, cookieHeader: string) => Promise<string>;

/**
 * Default scraper implementation using real HTTP calls.
 *
 * Always authenticated (feature 005): the MAN v FAT fixtures page is gated behind a WordPress
 * login, so a session is **required**. `fetchHtml` fetches the page, and if the response is not
 * authenticated (`isAuthenticated` false — no `logged-in` body class), re-logs in **at most once**
 * and retries; persistent failure raises `AuthError`. Authentication state, not fixture presence,
 * is the trigger — an authenticated-but-empty (off-season) page is returned as a valid result
 * (FR-005a). The login POST and each page GET are rate-limited individually via the shared queue.
 *
 * Tests never construct this directly — they inject a mock at the `IFixtureScraper` boundary
 * (`MockFixtureScraper` etc.), so the auth path stays below the boundary (FR-008).
 */
export class DefaultFixtureScraper implements IFixtureScraper {
  private readonly fetchPage: FetchPageFn;

  constructor(
    private readonly session: IManvfatSession,
    fetchPage?: FetchPageFn
  ) {
    this.fetchPage =
      fetchPage ?? ((url, cookieHeader) => fetchWithRetry(url, 3, 1000, cookieHeader));
  }

  async fetchHtml(url: string): Promise<string> {
    // Fetch with whatever cookie the jar currently holds (empty string on a brand-new session —
    // that fetch simply comes back unauthenticated and the recovery branch logs in). Cookie
    // *presence* is deliberately NOT used as the auth gate: `isAuthenticated` on the response is
    // the single source of truth, so "no cookie" and "expired cookie" are handled identically.
    let html = await this.fetchPage(url, this.session.cookieHeader(url));

    if (!isAuthenticated(html)) {
      // At-most-once re-login (FR-004): login() persists the refreshed encrypted jar.
      await this.session.login();
      html = await this.fetchPage(url, this.session.cookieHeader(url));

      if (!isAuthenticated(html)) {
        throw new AuthError(
          'MAN v FAT returned an unauthenticated page after re-login. The stored ' +
            'credentials may be invalid — check MANVFAT_USERNAME / MANVFAT_PASSWORD for this team.'
        );
      }
    }

    // May be authenticated-but-empty (off-season) — that is a valid empty result (FR-005a).
    return html;
  }

  parseFixtures(html: string): Fixture[] {
    return scrapeFixtures(html);
  }
}
