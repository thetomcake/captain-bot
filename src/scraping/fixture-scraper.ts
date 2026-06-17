import axios from 'axios';
import * as cheerio from 'cheerio';
import { withRetry } from '../utils/retry.js';
import { enqueueRequest } from './request-queue.js';
import type { IManvfatSession } from './manvfat-session.js';

export interface Fixture {
  date: string; // ISO format YYYY-MM-DD
  time: string; // HH:MM format
  opponent: string;
  venue: string;
  status: 'upcoming' | 'completed' | 'cancelled';
  homeTeam?: string;
  awayTeam?: string;
  homeScore?: number;
  awayScore?: number;
}

/**
 * Extract date from week header text
 * @param weekText - Text like "Week 7 - June 29th"
 * @param year - Optional year (defaults to current year with inference)
 * @returns ISO date string "YYYY-MM-DD"
 */
export function extractDate(weekText: string, year?: number): string {
  // Parse "Week N - Month DDth/st/nd/rd" format
  const dateMatch = weekText.match(/Week\s+\d+\s+-\s+(\w+)\s+(\d+)(?:st|nd|rd|th)/i);

  if (!dateMatch) {
    throw new Error(`Unable to parse date from: ${weekText}`);
  }

  const monthName = dateMatch[1];
  const day = dateMatch[2];

  if (!monthName || !day) {
    throw new Error(`Invalid date format: ${weekText}`);
  }

  // Month name to number mapping
  const months: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  const month = months[monthName.toLowerCase()];
  if (month === undefined) {
    throw new Error(`Unknown month: ${monthName}`);
  }

  // If no year provided, infer from current date
  if (!year) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // If we're in December and the fixture is in January-March, use next year
    // If we're in Jan-Mar and the fixture is in Oct-Dec, use previous year
    if (currentMonth >= 10 && month <= 2) {
      year = currentYear + 1;
    } else if (currentMonth <= 2 && month >= 10) {
      year = currentYear - 1;
    } else {
      year = currentYear;
    }
  }

  // Create date and format as ISO string
  const date = new Date(year, month, parseInt(day));
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Scrape fixtures from MAN v FAT club page HTML
 * @param html - HTML content from club page
 * @returns Array of fixtures with date, time, opponent, venue
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
      const date = extractDate(weekText);

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

        // Determine game status
        let status: Fixture['status'] = 'upcoming';
        if (homeScore !== undefined && awayScore !== undefined) {
          status = 'completed';
        }

        // Determine opponent (we assume we're the away team for simplicity)
        // In a real implementation, this would be configurable or detected
        const opponent = homeTeam;

        // Venue defaults to club venue (not specified in HTML)
        const venue = 'Club Venue';

        fixtures.push({
          date,
          time,
          opponent,
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
 * Default scraper implementation using real HTTP calls.
 *
 * Always authenticated (feature 005): the MAN v FAT fixtures page is gated behind a WordPress
 * login, so a session is **required**. `fetchHtml` logs in if no stored cookie exists, then
 * attaches the session's cookie header to the GET. The login POST and the page GET are each
 * rate-limited individually via the shared queue (`request-queue.ts`).
 *
 * Tests never construct this directly — they inject a mock at the `IFixtureScraper` boundary
 * (`MockFixtureScraper` etc.), so the auth path stays below the boundary (FR-008).
 */
export class DefaultFixtureScraper implements IFixtureScraper {
  constructor(private readonly session: IManvfatSession) {}

  async fetchHtml(url: string): Promise<string> {
    // No stored cookie → log in first so the very first fetch carries the session. (Reactive
    // re-login on an *expired* cookie is added in US2's recovery loop — feature 005 T017.)
    if (!this.session.hasCookie(url)) {
      await this.session.login();
    }

    // The GET is rate-limited at the request boundary inside fetchWithRetry; login() rate-limits
    // its own POST. Both are sequential leaf requests — never nested in one queue token.
    return fetchWithRetry(url, 3, 1000, this.session.cookieHeader(url));
  }

  parseFixtures(html: string): Fixture[] {
    return scrapeFixtures(html);
  }
}
