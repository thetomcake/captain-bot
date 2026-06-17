import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as schema from '#src/database/schema.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { buildPollSpec } from '#src/whatsapp/poll-presenter.js';
import { normaliseOurFixtures } from '#src/scraping/fixture-normaliser.js';
import { scrapeFixtures, type Fixture } from '#src/scraping/fixture-scraper.js';
import { logger } from '#src/utils/logger.js';
import { reloadEnv } from '#src/config/env.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import type { Game } from '#src/types/entities.js';

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, `../../fixtures/html/${name}`), 'utf-8');

// US1 (spec 006): the availability poll targets OUR team's soonest unplayed future game (home or
// away), opponent = the other side; no `TEAM_NAME` match -> no fixture + a mismatch log; poll text
// is unchanged by home vs away. Static fixtures + a fixed `now` make selection deterministic.
const TEAM = 'White Team';
const NOW = new Date(2026, 10, 1); // 1 Nov 2026 — earlier than every fixture in us1-home-away.html

describe('US1 — poll targets our team’s next game', () => {
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

  function service(html: string): FixtureService {
    return new FixtureService(
      test.db,
      new SeasonService(test.db),
      new MockFixtureScraper(html),
      () => NOW
    );
  }

  it('selects our soonest unplayed game even when it is NOT the earliest league game (AS1) with the right home opponent (AS2)', async () => {
    await service(fixture('us1-home-away.html')).fetchFixtures(teamId);

    const upcoming = await new FixtureService(
      test.db,
      new SeasonService(test.db),
      undefined,
      () => NOW
    ).getUpcomingFixtures(seasonId);

    // Earliest league game (Blue v Red, Nov 2) is not ours and is filtered out; our next is Nov 9.
    expect(upcoming[0]).toMatchObject({ opponent: 'Green Team' });
    expect(upcoming[0]?.gameDate.getFullYear()).toBe(2026);
    expect(upcoming[0]?.gameDate.getMonth()).toBe(10); // November
    expect(upcoming[0]?.gameDate.getDate()).toBe(9);
  });

  it('derives the opponent as the other side when we are away (AS3)', async () => {
    await service(fixture('us1-home-away.html')).fetchFixtures(teamId);

    const upcoming = await new FixtureService(
      test.db,
      new SeasonService(test.db),
      undefined,
      () => NOW
    ).getUpcomingFixtures(seasonId);

    // Second of our fixtures: Yellow Team v White Team (Nov 16) -> opponent Yellow Team.
    expect(upcoming.map((g) => g.opponent)).toEqual(['Green Team', 'Yellow Team']);
  });

  it('stores nothing, emits a likely-mismatch log, and yields no upcoming fixture when no game features our team (AS4/FR-005)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await service(fixture('no-team.html')).fetchFixtures(teamId);

    const upcoming = await new FixtureService(
      test.db,
      new SeasonService(test.db),
      undefined,
      () => NOW
    ).getUpcomingFixtures(seasonId);

    expect(upcoming).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0]!;
    expect(message).toMatch(/none feature our team|TEAM_NAME/i);
    // Counts/names only — never credentials/cookies (Principle IV).
    expect(JSON.stringify(meta)).not.toMatch(/cookie|password|credential/i);
  });

  it('produces byte-identical poll content for a home vs away fixture against the same opponent (FR-006/SC-006)', () => {
    const parseRows = (html: string): Fixture[] => scrapeFixtures(html);

    // Same opponent + same kickoff, differing only in which side we are.
    const homeHtml = oneGame('White Team', 'Green Team');
    const awayHtml = oneGame('Green Team', 'White Team');

    const home = normaliseOurFixtures(parseRows(homeHtml), TEAM, NOW).fixtures[0]!;
    const away = normaliseOurFixtures(parseRows(awayHtml), TEAM, NOW).fixtures[0]!;

    expect(home.opponent).toBe('Green Team');
    expect(away.opponent).toBe('Green Team');

    const toGame = (f: { date: string; time: string; opponent: string; venue: string }): Game => ({
      id: 1,
      seasonId,
      gameDate: new Date(`${f.date}T${f.time}:00`),
      opponent: f.opponent,
      venue: f.venue,
      status: 'upcoming',
      scrapedUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(buildPollSpec(toGame(home))).toEqual(buildPollSpec(toGame(away)));
  });
});

/** A one-week, one-game page (Nov 9, 19:30) with the given home/away teams. */
function oneGame(home: string, away: string): string {
  return `<html><body class="logged-in"><div class="col"><div class="mod">
    <div class="group-header white">Week 2 - November 9th</div>
    <div class="responsive-table"><table class="fixture-table">
      <tr class="no-highlight">
        <td class="game-week-no" rowspan="1">19:30<br>League</td>
        <td class="team-name">${home}</td>
        <td class="score home neutral">-</td>
        <td class="versus">v</td>
        <td class="score away neutral">-</td>
        <td class="team-name">${away}</td>
      </tr>
    </table></div>
  </div></div></body></html>`;
}
