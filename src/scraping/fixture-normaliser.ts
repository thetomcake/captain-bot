import type { Fixture } from './fixture-scraper.js';

/**
 * A league fixture restricted to those featuring our team, with the derived opponent and an
 * absolute ISO date (spec 006, contract C2 / data-model `OurFixture`). This is what the service
 * persists into `games` — it carries the same `date`/`time`/`opponent`/`venue`/`status` shape the
 * persistence path has always consumed.
 */
export interface OurFixture {
  date: string; // ISO YYYY-MM-DD
  time: string; // HH:MM
  opponent: string;
  venue: string;
  status: Fixture['status'];
}

/**
 * Result of normalising a scraped league list down to our-team fixtures.
 */
export interface NormaliseResult {
  /** Our-team fixtures, in the order the league list presented them. */
  fixtures: OurFixture[];
  /**
   * True when the scrape returned >= 1 league fixture but NONE feature our team — the FR-005
   * "likely TEAM_NAME mismatch" signal. False when there were our-team fixtures, and false when
   * the league list was empty (an empty page is off-season, not a mismatch).
   */
  leagueFixturesButNoneOurs: boolean;
}

/** Whitespace-normalised, case-insensitive comparison key for a team name (FR-001). */
function normalise(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Format `year-month-day` as a zero-padded ISO date. */
function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Filter a parsed league list to our-team fixtures, derive each opponent, and assign a calendar
 * year (spec 006, contract C2 — pure function of its inputs, no clock).
 *
 * - **FR-001 filter**: keep only fixtures where `teamName` is the home or away side, compared
 *   whitespace-normalised + case-insensitively; discard all other-team pairings.
 * - **FR-003 opponent**: the opponent is the side that is NOT our team, whether we are home or away.
 * - **FR-002 year (provisional)**: every fixture is assigned `today`'s calendar year. This is correct
 *   within a single calendar year (US1); the boundary-correct page-order assignment (December ->
 *   January wrap) is layered on in US2 (T012). It deliberately does NOT guess a year per month.
 * - **FR-005 mismatch**: surfaces `leagueFixturesButNoneOurs` so the caller can log a likely
 *   `TEAM_NAME` mismatch and treat the scrape as yielding no fixtures.
 *
 * @param parsed - faithful league rows from `scrapeFixtures`
 * @param teamName - our team's name (from the loaded config)
 * @param today - anchor date for year assignment (injectable for deterministic tests)
 */
export function normaliseOurFixtures(
  parsed: Fixture[],
  teamName: string,
  today: Date
): NormaliseResult {
  const target = normalise(teamName);
  const year = today.getFullYear();

  const fixtures: OurFixture[] = [];
  for (const f of parsed) {
    const homeMatches = normalise(f.homeTeam) === target;
    const awayMatches = normalise(f.awayTeam) === target;

    if (!homeMatches && !awayMatches) {
      continue; // not our fixture — discard the other-team pairing (FR-001)
    }

    const opponent = homeMatches ? f.awayTeam : f.homeTeam; // FR-003

    fixtures.push({
      date: toIsoDate(year, f.month, f.day),
      time: f.time,
      opponent,
      venue: f.venue,
      status: f.status,
    });
  }

  return {
    fixtures,
    leagueFixturesButNoneOurs: parsed.length > 0 && fixtures.length === 0,
  };
}
