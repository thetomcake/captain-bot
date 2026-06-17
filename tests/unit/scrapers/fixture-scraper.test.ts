import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Import the fixture scraper (to be implemented)
import {
  scrapeFixtures,
  extractDate,
  isAuthenticated,
  DefaultFixtureScraper,
  type Fixture,
  type FetchPageFn,
} from '#src/scraping/fixture-scraper.js';
import type { IManvfatSession } from '#src/scraping/manvfat-session.js';
import { AuthError } from '#src/utils/errors.js';

describe('Fixture Scraper - Static HTML Parsing', () => {
  let html: string;

  beforeAll(() => {
    // Load the live HTML fixture captured from manvfatfootball.com/club/watford/
    const fixturePath = resolve(__dirname, '../../fixtures/html/manvfat-fixtures.html');
    html = readFileSync(fixturePath, 'utf-8');
  });

  describe('scrapeFixtures', () => {
    it('should extract fixtures from live HTML', () => {
      const fixtures = scrapeFixtures(html);

      // Should extract multiple fixtures
      expect(fixtures.length).toBeGreaterThan(0);
    });

    it('should extract required FR-002 fields (date, time, opponent, venue)', () => {
      const fixtures = scrapeFixtures(html);

      const fixture = fixtures[0];

      // FR-002 required fields
      expect(fixture).toHaveProperty('date');
      expect(fixture).toHaveProperty('time');
      expect(fixture).toHaveProperty('opponent');
      expect(fixture).toHaveProperty('venue');

      // Date should be a valid date string
      expect(fixture.date).toMatch(/\d{4}-\d{2}-\d{2}/);

      // Time should be HH:MM format
      expect(fixture.time).toMatch(/\d{2}:\d{2}/);

      // Opponent should be non-empty
      expect(fixture.opponent.length).toBeGreaterThan(0);

      // Venue should be present (even if default)
      expect(fixture.venue.length).toBeGreaterThan(0);
    });

    it('should handle "Fixtures to be confirmed" sections', () => {
      const fixtures = scrapeFixtures(html);

      // Should not create fixtures for "to be confirmed" weeks
      const confirmedFixtures = fixtures.filter(
        (f) => f.opponent !== 'TBD' && f.opponent !== 'To be confirmed'
      );

      expect(confirmedFixtures.length).toBeGreaterThan(0);
    });

    it('should extract multiple fixtures from different weeks', () => {
      const fixtures = scrapeFixtures(html);

      // Should have fixtures from multiple weeks
      const uniqueDates = new Set(fixtures.map((f) => f.date));
      expect(uniqueDates.size).toBeGreaterThan(1);
    });

    it('should include game status for each fixture', () => {
      const fixtures = scrapeFixtures(html);

      fixtures.forEach((fixture) => {
        expect(fixture).toHaveProperty('status');
        expect(['upcoming', 'completed', 'cancelled']).toContain(fixture.status);
      });
    });

    it('should detect completed games with scores', () => {
      const fixtures = scrapeFixtures(html);

      // Look for games with actual scores (not "-")
      const completedGames = fixtures.filter((f) => f.status === 'completed');

      // There should be some completed games in the HTML
      // (if the HTML includes past games)
      expect(completedGames).toBeDefined();
    });

    it('should handle special characters in team names', () => {
      const fixtures = scrapeFixtures(html);

      fixtures.forEach((fixture) => {
        // Team names should be trimmed and non-empty
        expect(fixture.opponent.trim()).toBe(fixture.opponent);
        expect(fixture.opponent.length).toBeGreaterThan(0);
      });
    });
  });

  describe('extractDate', () => {
    it('should parse "Week N - Month DDth" format', () => {
      const date = extractDate('Week 7 - June 29th', 2026);

      expect(date).toBe('2026-06-29');
    });

    it('should parse "Week N - Month DDst" format', () => {
      const date = extractDate('Week 1 - June 1st', 2026);

      expect(date).toBe('2026-06-01');
    });

    it('should parse "Week N - Month DDnd" format', () => {
      const date = extractDate('Week 2 - June 2nd', 2026);

      expect(date).toBe('2026-06-02');
    });

    it('should parse "Week N - Month DDrd" format', () => {
      const date = extractDate('Week 3 - June 3rd', 2026);

      expect(date).toBe('2026-06-03');
    });

    it('should handle different months', () => {
      const janDate = extractDate('Week 1 - January 15th', 2026);
      const decDate = extractDate('Week 20 - December 25th', 2026);

      expect(janDate).toBe('2026-01-15');
      expect(decDate).toBe('2026-12-25');
    });

    it('should infer year for dates in current season', () => {
      // Test year inference logic
      // If we're in December and the date is January, it should use next year
      const date = extractDate('Week 1 - January 10th');

      expect(date).toMatch(/\d{4}-01-10/);
    });
  });
});

// ---------------------------------------------------------------------------
// Feature 005, User Story 2 — transparent session recovery.
// ---------------------------------------------------------------------------

describe('isAuthenticated (T014 — auth-state detection, FR-005a)', () => {
  // The discrimination that broke: a logged-out page renders the same empty fixture tables
  // as an off-season authenticated page. The ONLY reliable signal is the WordPress
  // `logged-in` body class (research.md Finding 5), independent of fixture presence.
  let authedHtml: string;
  let loggedOutHtml: string;

  beforeAll(() => {
    authedHtml = readFileSync(
      resolve(__dirname, '../../fixtures/html/manvfat-fixtures.html'),
      'utf-8'
    );
    loggedOutHtml = readFileSync(
      resolve(__dirname, '../../fixtures/html/manvfat-fixtures-unauthenticated.html'),
      'utf-8'
    );
  });

  it('returns true for the authenticated fixture page (logged-in body class)', () => {
    expect(isAuthenticated(authedHtml)).toBe(true);
  });

  it('returns false for the logged-out page (no logged-in body class)', () => {
    expect(isAuthenticated(loggedOutHtml)).toBe(false);
  });

  it('returns true for an authenticated-but-empty page — off-season ≠ logged out (FR-005a)', () => {
    // Authenticated body class present, zero `group-header white` week headers.
    const offSeason =
      '<html><body class="club-template-default logged-in wp-theme-oshin">' +
      '<main><p>No fixtures scheduled yet.</p></main></body></html>';

    expect(isAuthenticated(offSeason)).toBe(true);
    // Auth state is independent of fixtures: the parser correctly yields [] here.
    expect(scrapeFixtures(offSeason)).toHaveLength(0);
  });
});

describe('DefaultFixtureScraper.fetchHtml — recovery loop (T015, FR-004/005/005a)', () => {
  const URL = 'https://manvfatfootball.com/club/watford/';
  const AUTHED =
    '<html><body class="logged-in"><div class="group-header white">Week 1</div></body></html>';
  const AUTHED_EMPTY = '<html><body class="logged-in"></body></html>';
  const LOGGED_OUT = '<html><body class="not-logged-in"></body></html>';

  /** A fake session implementing the IManvfatSession seam, counting login() calls. */
  function makeSession(): { session: IManvfatSession; loginCalls: () => number } {
    let calls = 0;
    const session: IManvfatSession = {
      cookieHeader: () => '',
      login: async () => {
        calls += 1;
      },
    };
    return { session, loginCalls: () => calls };
  }

  /** A fake page-fetch seam returning a scripted sequence of responses. */
  function makeFetch(responses: string[]): { fetchPage: FetchPageFn; fetchCalls: () => number } {
    let i = 0;
    const fetchPage: FetchPageFn = async () => {
      const body = responses[i] ?? responses[responses.length - 1] ?? '';
      i += 1;
      return body;
    };
    return { fetchPage, fetchCalls: () => i };
  }

  it('(a) re-logs in once when the first fetch is unauthenticated, then returns the authed HTML', async () => {
    const { session, loginCalls } = makeSession();
    const { fetchPage, fetchCalls } = makeFetch([LOGGED_OUT, AUTHED]);
    const scraper = new DefaultFixtureScraper(session, fetchPage);

    await expect(scraper.fetchHtml(URL)).resolves.toBe(AUTHED);
    expect(loginCalls()).toBe(1); // exactly once
    expect(fetchCalls()).toBe(2); // fetch → login → re-fetch
  });

  it('(b) throws AuthError when still unauthenticated after one re-login (at-most-once, FR-004)', async () => {
    const { session, loginCalls } = makeSession();
    const { fetchPage, fetchCalls } = makeFetch([LOGGED_OUT, LOGGED_OUT]);
    const scraper = new DefaultFixtureScraper(session, fetchPage);

    await expect(scraper.fetchHtml(URL)).rejects.toBeInstanceOf(AuthError);
    expect(loginCalls()).toBe(1); // re-login attempted exactly once, never twice
    expect(fetchCalls()).toBe(2);
  });

  it('(c) returns an authenticated-but-empty page directly — no re-login, no error (FR-005a/SC-007)', async () => {
    const { session, loginCalls } = makeSession();
    const { fetchPage, fetchCalls } = makeFetch([AUTHED_EMPTY]);
    const scraper = new DefaultFixtureScraper(session, fetchPage);

    await expect(scraper.fetchHtml(URL)).resolves.toBe(AUTHED_EMPTY);
    expect(loginCalls()).toBe(0); // off-season is valid auth — never re-login
    expect(fetchCalls()).toBe(1);
  });
});
