import { describe, it, expect } from 'vitest';
import { normaliseOurFixtures } from '#src/scraping/fixture-normaliser.js';
import type { Fixture } from '#src/scraping/fixture-scraper.js';

// Pure-function tests for the normaliser (spec 006, contract C2). A fixed `today` within a single
// calendar year is used throughout — the December -> January page-order wrap is US2 (T012).
const TEAM = 'White Team';
const TODAY = new Date(2026, 10, 1); // 1 Nov 2026 (month is 0-indexed in the Date ctor)

function fix(overrides: Partial<Fixture> & Pick<Fixture, 'homeTeam' | 'awayTeam'>): Fixture {
  return {
    month: 11,
    day: 9,
    time: '19:30',
    venue: 'Club Venue',
    status: 'upcoming',
    ...overrides,
  };
}

describe('normaliseOurFixtures (C2)', () => {
  describe('FR-001 — filter to our team', () => {
    it('keeps only fixtures featuring our team and discards other-team pairings', () => {
      const parsed = [
        fix({ homeTeam: 'Blue team', awayTeam: 'Red team' }), // not ours
        fix({ homeTeam: 'White Team', awayTeam: 'Green Team' }), // ours (home)
        fix({ homeTeam: 'Yellow Team', awayTeam: 'White Team' }), // ours (away)
      ];

      const { fixtures } = normaliseOurFixtures(parsed, TEAM, TODAY);

      expect(fixtures).toHaveLength(2);
      expect(fixtures.map((f) => f.opponent)).toEqual(['Green Team', 'Yellow Team']);
    });

    it('matches whitespace-normalised + case-insensitively', () => {
      const parsed = [
        fix({ homeTeam: '  white   TEAM ', awayTeam: 'Green Team' }),
        fix({ homeTeam: 'Green Team', awayTeam: 'white team' }),
      ];

      const { fixtures } = normaliseOurFixtures(parsed, TEAM, TODAY);

      expect(fixtures).toHaveLength(2);
      expect(fixtures.map((f) => f.opponent)).toEqual(['Green Team', 'Green Team']);
    });
  });

  describe('FR-003 — opponent is the other side, home or away', () => {
    it('takes the away team when we are home', () => {
      const { fixtures } = normaliseOurFixtures(
        [fix({ homeTeam: 'White Team', awayTeam: 'Green Team' })],
        TEAM,
        TODAY
      );
      expect(fixtures[0]?.opponent).toBe('Green Team');
    });

    it('takes the home team when we are away', () => {
      const { fixtures } = normaliseOurFixtures(
        [fix({ homeTeam: 'Yellow Team', awayTeam: 'White Team' })],
        TEAM,
        TODAY
      );
      expect(fixtures[0]?.opponent).toBe('Yellow Team');
    });
  });

  describe('FR-002 (provisional) — year anchored to today within a single calendar year', () => {
    it('assigns today’s year to the week month/day as an ISO date', () => {
      const { fixtures } = normaliseOurFixtures(
        [fix({ homeTeam: 'White Team', awayTeam: 'Green Team', month: 11, day: 9 })],
        TEAM,
        TODAY
      );
      expect(fixtures[0]?.date).toBe('2026-11-09');
    });

    it('carries time, venue and status through unchanged', () => {
      const { fixtures } = normaliseOurFixtures(
        [fix({ homeTeam: 'White Team', awayTeam: 'Green Team', status: 'completed', time: '20:00' })],
        TEAM,
        TODAY
      );
      expect(fixtures[0]).toMatchObject({ time: '20:00', venue: 'Club Venue', status: 'completed' });
    });
  });

  describe('FR-005 — league fixtures present but none ours', () => {
    it('flags the mismatch when >=1 fixture was scraped but none feature our team', () => {
      const result = normaliseOurFixtures(
        [fix({ homeTeam: 'Blue team', awayTeam: 'Red team' })],
        TEAM,
        TODAY
      );
      expect(result.fixtures).toHaveLength(0);
      expect(result.leagueFixturesButNoneOurs).toBe(true);
    });

    it('does NOT flag when there were our-team fixtures', () => {
      const result = normaliseOurFixtures(
        [fix({ homeTeam: 'White Team', awayTeam: 'Green Team' })],
        TEAM,
        TODAY
      );
      expect(result.leagueFixturesButNoneOurs).toBe(false);
    });

    it('does NOT flag an empty league list (off-season, not a mismatch)', () => {
      const result = normaliseOurFixtures([], TEAM, TODAY);
      expect(result.fixtures).toHaveLength(0);
      expect(result.leagueFixturesButNoneOurs).toBe(false);
    });
  });
});
