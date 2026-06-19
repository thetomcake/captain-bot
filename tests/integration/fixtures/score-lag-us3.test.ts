import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as schema from '#src/database/schema.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { reloadEnv } from '#src/config/env.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, `../../fixtures/html/${name}`), 'utf-8');

// US3 (spec 006): a game already played but still showing `-` (≤5-day score lag) is excluded from
// selection by the future-date guard; a genuine future game — including one later TODAY not yet
// kicked off — is selectable (FR-004/FR-008, contract C3). The clock is faked so a static fixture
// behaves as past/future without dynamic HTML.
const TEAM = 'White Team';

describe('US3 — recently-played game with pending score is not chosen', () => {
  let test: TestDatabase;
  let teamId: number;
  let seasonId: number;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ teamName: TEAM }));
    reloadEnv();

    test = createTestDatabase();
    const [team] = await test.db
      .insert(schema.teams)
      .values({ name: TEAM, clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    teamId = team!.id;
    const [season] = await test.db
      .insert(schema.seasons)
      .values({ teamId, seasonNumber: 1, isCurrent: true })
      .returning();
    seasonId = season!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    test.close();
  });

  function service(html: string, now: Date): FixtureService {
    return new FixtureService(
      test.db,
      new SeasonService(test.db),
      new MockFixtureScraper(html),
      () => now
    );
  }

  it('ignores a past game still showing `-` and selects the genuine future game (AS1/SC-004)', async () => {
    // score-lag.html: Week 5 (Oct 12, still `-`) is past; Week 6 (Nov 9, `-`) is future.
    const now = new Date(2026, 9, 20, 12, 0); // 20 Oct 2026 — between the two weeks
    await service(fixture('score-lag.html'), now).fetchFixtures(teamId);

    const upcoming = await new FixtureService(
      test.db,
      new SeasonService(test.db),
      undefined,
      () => now
    ).getUpcomingFixtures(seasonId);

    // The past Oct 12 `-` game is excluded; the future Nov 9 game (we are away vs Green Team) wins.
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({ opponent: 'Green Team' });
    expect(upcoming[0]?.gameDate.getMonth()).toBe(10); // November
    expect(upcoming[0]?.gameDate.getDate()).toBe(9);
  });

  it('yields no confirmed next fixture when the only `-` fixture is in the past (AS2)', async () => {
    const html = page([week('Week 5 - October 12th', 'White Team', 'Red Team', '19:00')]);
    const now = new Date(2026, 9, 20, 12, 0); // after the Oct 12 kickoff

    await service(html, now).fetchFixtures(teamId);

    const upcoming = await new FixtureService(
      test.db,
      new SeasonService(test.db),
      undefined,
      () => now
    ).getUpcomingFixtures(seasonId);

    expect(upcoming).toHaveLength(0);
  });

  it('selects a game later TODAY that has not yet kicked off (AS3)', async () => {
    const html = page([week('Week 7 - November 9th', 'White Team', 'Blue Team', '19:30')]);
    const now = new Date(2026, 10, 9, 10, 0); // 9 Nov 2026 10:00 — same day, before 19:30 kickoff

    await service(html, now).fetchFixtures(teamId);

    const upcoming = await new FixtureService(
      test.db,
      new SeasonService(test.db),
      undefined,
      () => now
    ).getUpcomingFixtures(seasonId);

    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({ opponent: 'Blue Team' });
    expect(upcoming[0]?.gameDate.getHours()).toBe(19);
    expect(upcoming[0]?.gameDate.getDate()).toBe(9);
  });
});

/** One unplayed league row (both scores `-`) inside a week group. */
function week(header: string, home: string, away: string, time: string): string {
  return `<div class="col"><div class="mod">
    <div class="group-header white">${header}</div>
    <div class="responsive-table"><table class="fixture-table">
      <tr class="no-highlight">
        <td class="game-week-no" rowspan="1">${time}<br>League</td>
        <td class="team-name">${home}</td>
        <td class="score home neutral">-</td>
        <td class="versus">v</td>
        <td class="score away neutral">-</td>
        <td class="team-name">${away}</td>
      </tr>
    </table></div>
  </div></div>`;
}

/** Wrap week groups (in chronological page order) into a logged-in club page. */
function page(weeks: string[]): string {
  return `<html><body class="logged-in">${weeks.join('')}</body></html>`;
}
