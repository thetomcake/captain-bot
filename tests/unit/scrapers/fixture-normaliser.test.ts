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

  describe('FR-002 — year from page order anchored to today', () => {
    it('assigns today’s year to the week month/day within a single calendar year', () => {
      const { fixtures } = normaliseOurFixtures(
        [fix({ homeTeam: 'White Team', awayTeam: 'Green Team', month: 11, day: 9 })],
        TEAM,
        TODAY
      );
      expect(fixtures[0]?.date).toBe('2026-11-09');
    });

    it('rolls the year over when the month wraps December -> January (page order)', () => {
      const lateDecember = new Date(2026, 11, 20); // 20 Dec 2026
      const { fixtures } = normaliseOurFixtures(
        [
          fix({ homeTeam: 'White Team', awayTeam: 'Red team', month: 12, day: 28 }),
          fix({ homeTeam: 'Blue team', awayTeam: 'White Team', month: 1, day: 4 }),
        ],
        TEAM,
        lateDecember
      );
      expect(fixtures.map((f) => f.date)).toEqual(['2026-12-28', '2027-01-04']);
    });

    it('detects the wrap even when the lower-month week belongs to another team', () => {
      const lateDecember = new Date(2026, 11, 20);
      const { fixtures } = normaliseOurFixtures(
        [
          fix({ homeTeam: 'White Team', awayTeam: 'Red team', month: 12, day: 28 }), // ours (Dec)
          fix({ homeTeam: 'Blue team', awayTeam: 'Green Team', month: 1, day: 4 }), // other team's Jan
          fix({ homeTeam: 'White Team', awayTeam: 'Yellow Team', month: 1, day: 11 }), // ours (Jan)
        ],
        TEAM,
        lateDecember
      );
      // The Jan rollover is triggered by the filtered-out Blue v Green week, so our Jan 11 game
      // is correctly placed in the next year.
      expect(fixtures.map((f) => f.date)).toEqual(['2026-12-28', '2027-01-11']);
    });

    it('does not roll the year over for a normal ascending month sequence', () => {
      const { fixtures } = normaliseOurFixtures(
        [
          fix({ homeTeam: 'White Team', awayTeam: 'Red team', month: 11, day: 9 }),
          fix({ homeTeam: 'White Team', awayTeam: 'Green Team', month: 12, day: 7 }),
        ],
        TEAM,
        TODAY
      );
      expect(fixtures.map((f) => f.date)).toEqual(['2026-11-09', '2026-12-07']);
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
