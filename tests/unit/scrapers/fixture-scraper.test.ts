import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  scrapeFixtures,
  parseWeekDate,
  isAuthenticated,
  DefaultFixtureScraper,
  type FetchPageFn,
} from '#src/scraping/fixture-scraper.js';
import type { IManvfatSession } from '#src/scraping/manvfat-session.js';
import { AuthError } from '#src/utils/errors.js';

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, `../../fixtures/html/${name}`), 'utf-8');

// Contract C1 (spec 006): the parser is a faithful HTML -> rows parser. It surfaces the week's raw
// month/day + faithful home/away teams + `-`/numeric scores. It MUST NOT filter by team, derive an
// opponent, or guess the calendar year — those are the normaliser's job.
describe('scrapeFixtures (C1 — faithful parser)', () => {
  let html: string;

  beforeAll(() => {
    html = fixture('us1-home-away.html');
  });

  it('returns one row per league fixture (no team filtering in the parser)', () => {
    const fixtures = scrapeFixtures(html);
    expect(fixtures).toHaveLength(3);
  });

  it('reports faithful home/away team names whether or not our team is involved', () => {
    const fixtures = scrapeFixtures(html);

    expect(fixtures[0]).toMatchObject({ homeTeam: 'Blue team', awayTeam: 'Red team' });
    expect(fixtures[1]).toMatchObject({ homeTeam: 'White Team', awayTeam: 'Green Team' });
    expect(fixtures[2]).toMatchObject({ homeTeam: 'Yellow Team', awayTeam: 'White Team' });
  });

  it('surfaces the week month + day and does NOT produce a year-bearing date or an opponent', () => {
    const fixtures = scrapeFixtures(html);

    expect(fixtures[0]).toMatchObject({ month: 11, day: 2, time: '19:00' });
    expect(fixtures[1]).toMatchObject({ month: 11, day: 9, time: '19:30' });
    expect(fixtures[2]).toMatchObject({ month: 11, day: 16, time: '20:00' });

    // Year/opponent are the normaliser's responsibility — not surfaced here.
    expect(fixtures[0]).not.toHaveProperty('date');
    expect(fixtures[0]).not.toHaveProperty('opponent');
  });

  it('sets status = completed iff BOTH scores are numeric, else upcoming', () => {
    const both = scrapeFixtures(scoreRow('3', '1'));
    expect(both[0]).toMatchObject({ status: 'completed', homeScore: 3, awayScore: 1 });

    const onePending = scrapeFixtures(scoreRow('3', '-'));
    expect(onePending[0]).toMatchObject({ status: 'upcoming' });
    expect(onePending[0]?.awayScore).toBeUndefined();

    const unplayed = scrapeFixtures(scoreRow('-', '-'));
    expect(unplayed[0]).toMatchObject({ status: 'upcoming' });
  });

  it('skips "Fixtures to be confirmed" placeholder rows', () => {
    const html = weekBlock(`
      <tr class="no-highlight"><td class="subtitle">Fixtures to be confirmed</td></tr>
      ${gameRow('19:00', 'White Team', 'Green Team', '-', '-')}
    `);
    const fixtures = scrapeFixtures(html);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ homeTeam: 'White Team', awayTeam: 'Green Team' });
  });
});

describe('parseWeekDate (C1 — month/day only, no year guessing)', () => {
  it('parses "Week N - Month DDth/st/nd/rd" into month (1-12) + day', () => {
    expect(parseWeekDate('Week 7 - June 29th')).toEqual({ month: 6, day: 29 });
    expect(parseWeekDate('Week 1 - June 1st')).toEqual({ month: 6, day: 1 });
    expect(parseWeekDate('Week 2 - June 2nd')).toEqual({ month: 6, day: 2 });
    expect(parseWeekDate('Week 3 - June 3rd')).toEqual({ month: 6, day: 3 });
  });

  it('never infers a year — January and December parse identically regardless of "now"', () => {
    expect(parseWeekDate('Week 1 - January 10th')).toEqual({ month: 1, day: 10 });
    expect(parseWeekDate('Week 20 - December 25th')).toEqual({ month: 12, day: 25 });
  });

  it('throws on an unparseable header', () => {
    expect(() => parseWeekDate('not a week header')).toThrow();
  });
});

// --- small inline-HTML builders for the status/TBD cases (single week, single table) ---
function weekBlock(rows: string): string {
  return `<html><body class="logged-in"><div class="col"><div class="mod">
    <div class="group-header white">Week 1 - November 2nd</div>
    <div class="responsive-table"><table class="fixture-table">${rows}</table></div>
  </div></div></body></html>`;
}
function gameRow(time: string, home: string, away: string, hs: string, as: string): string {
  return `<tr class="no-highlight">
    <td class="game-week-no" rowspan="1">${time}<br>League</td>
    <td class="team-name">${home}</td>
    <td class="score home neutral">${hs}</td>
    <td class="versus">v</td>
    <td class="score away neutral">${as}</td>
    <td class="team-name">${away}</td>
  </tr>`;
}
function scoreRow(hs: string, as: string): string {
  return weekBlock(gameRow('19:00', 'White Team', 'Red team', hs, as));
}

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
