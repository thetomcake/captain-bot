import { describe, it, expect } from 'vitest';
import {
  rate,
  aggregateSeason,
  aggregatePlayers,
  aggregateAttendance,
  aggregateReport,
  type AggregationInput,
  type Participation,
} from '#src/stats/aggregations.js';

/** Build an AggregationInput from participation rows, deriving games-by-status from the games arg. */
function makeInput(over: Partial<AggregationInput> = {}): AggregationInput {
  return {
    scopeLabel: 'Season 2',
    games: [],
    pollFixtureCount: 0,
    participation: [],
    ...over,
  };
}

function p(over: Partial<Participation>): Participation {
  return {
    gameId: 1,
    canonicalId: 'x@id',
    displayName: 'X',
    attended: true,
    goals: 0,
    assists: 0,
    weightDirection: null,
    foodTracking: false,
    hasStatRecord: false,
    ...over,
  };
}

describe('spec-008/SC-004 rate() helper', () => {
  it('returns null when the denominator is zero (never NaN, never Infinity)', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
  });

  it('returns the exact quotient for a positive denominator', () => {
    expect(rate(3, 4)).toBe(0.75);
    expect(rate(6, 2)).toBe(3);
    expect(rate(0, 5)).toBe(0);
  });

  it('never yields NaN or Infinity for any denominator', () => {
    for (const v of [rate(0, 0), rate(1, 0), rate(7, 0), rate(7, 3)]) {
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });
});

describe('spec-008/US-1 aggregateSeason', () => {
  // A hand-built two-player, two-completed-game season (mirrors the integration seed):
  //   g1 completed+poll: alice attended (2g/1a, down, food), bob attended (no stat → 0/0),
  //                      carol stat but NOT attended (1g/0a, up)
  //   g2 completed+poll: alice attended (3g/0a, same, food null→false), bob attended (0g/2a, down, food)
  //   g3 completed, no poll: alice stat but NOT attended (5g/5a, down, food)
  //   plus 1 cancelled, 1 upcoming game; pollFixtureCount = 2 (g1,g2)
  function richSeason(): AggregationInput {
    return makeInput({
      games: [
        { gameId: 1, status: 'completed' },
        { gameId: 2, status: 'completed' },
        { gameId: 3, status: 'completed' },
        { gameId: 4, status: 'cancelled' },
        { gameId: 5, status: 'upcoming' },
      ],
      pollFixtureCount: 2,
      participation: [
        p({
          gameId: 1,
          canonicalId: 'alice@id',
          attended: true,
          goals: 2,
          assists: 1,
          weightDirection: 'down',
          foodTracking: true,
          hasStatRecord: true,
        }),
        p({ gameId: 1, canonicalId: 'bob@id', attended: true, hasStatRecord: false }),
        p({
          gameId: 1,
          canonicalId: 'carol@id',
          attended: false,
          goals: 1,
          assists: 0,
          weightDirection: 'up',
          foodTracking: false,
          hasStatRecord: true,
        }),
        p({
          gameId: 2,
          canonicalId: 'alice@id',
          attended: true,
          goals: 3,
          assists: 0,
          weightDirection: 'same',
          foodTracking: false,
          hasStatRecord: true,
        }),
        p({
          gameId: 2,
          canonicalId: 'bob@id',
          attended: true,
          goals: 0,
          assists: 2,
          weightDirection: 'down',
          foodTracking: true,
          hasStatRecord: true,
        }),
        p({
          gameId: 3,
          canonicalId: 'alice@id',
          attended: false,
          goals: 5,
          assists: 5,
          weightDirection: 'down',
          foodTracking: true,
          hasStatRecord: true,
        }),
      ],
    });
  }

  it('sums totals over all completed-game stat records and counts games by status (FR-001, FR-014)', () => {
    const s = aggregateSeason(richSeason());
    expect(s.totalGoals).toBe(11); // 2+1+3+0+5
    expect(s.totalAssists).toBe(8); // 1+0+0+2+5
    expect(s.gamesByStatus).toEqual({ completed: 3, cancelled: 1, upcoming: 1 });
  });

  it('computes per-completed-game rates, squad size and turnout (FR-001, FR-014, FR-015)', () => {
    const s = aggregateSeason(richSeason());
    expect(s.goalsPerGame).toBeCloseTo(11 / 3, 10);
    expect(s.assistsPerGame).toBeCloseTo(8 / 3, 10);
    expect(s.squadSize).toBe(3); // alice, bob, carol
    expect(s.averageTurnoutPerFixture).toBe(2); // 4 Yes rows / 2 fixtures
  });

  it('squad lifestyle rates are the MEAN of per-player rates over attended players (FR-008, FR-010, Q5-amended)', () => {
    const s = aggregateSeason(richSeason());
    // alice WL 1/2, bob WL 1/2 → mean 0.5; carol excluded (0 attended games).
    expect(s.squadWeightLossRate).toBeCloseTo(0.5, 10);
    // alice food 1/2, bob food 1/2 → mean 0.5
    expect(s.squadFoodTrackingRate).toBeCloseTo(0.5, 10);
  });

  it('returns null rates (never NaN/0) when there are no completed games or attended players (SC-004)', () => {
    const empty = aggregateSeason(makeInput());
    expect(empty.hasData).toBe(false);
    expect(empty.goalsPerGame).toBeNull();
    expect(empty.assistsPerGame).toBeNull();
    expect(empty.averageTurnoutPerFixture).toBeNull();
    expect(empty.squadWeightLossRate).toBeNull();
    expect(empty.squadFoodTrackingRate).toBeNull();
  });

  it('hasData is true when the season has completed games (FR-011)', () => {
    expect(aggregateSeason(richSeason()).hasData).toBe(true);
  });
});

/**
 * The same two-player rich season the US-1 block uses, lifted to module scope so the per-player,
 * report, and attendance blocks all assert against one hand-calculated fixture.
 *   alice: attended g1 (2g/1a, down, food) + g2 (3g/0a, same, food=false); g3 stat NOT attended
 *   bob:   attended g1 (no stat → 0/0) + g2 (0g/2a, down, food)
 *   carol: g1 stat only, NOT attended
 *   pollFixtureCount = 2
 */
function sharedRichSeason(): AggregationInput {
  return makeInput({
    games: [
      { gameId: 1, status: 'completed' },
      { gameId: 2, status: 'completed' },
      { gameId: 3, status: 'completed' },
      { gameId: 4, status: 'cancelled' },
      { gameId: 5, status: 'upcoming' },
    ],
    pollFixtureCount: 2,
    participation: [
      p({
        gameId: 1,
        canonicalId: 'alice@id',
        displayName: 'Alice',
        attended: true,
        goals: 2,
        assists: 1,
        weightDirection: 'down',
        foodTracking: true,
        hasStatRecord: true,
      }),
      p({
        gameId: 1,
        canonicalId: 'bob@id',
        displayName: 'Bob',
        attended: true,
        hasStatRecord: false,
      }),
      p({
        gameId: 1,
        canonicalId: 'carol@id',
        displayName: 'Carol',
        attended: false,
        goals: 1,
        assists: 0,
        weightDirection: 'up',
        foodTracking: false,
        hasStatRecord: true,
      }),
      p({
        gameId: 2,
        canonicalId: 'alice@id',
        displayName: 'Alice',
        attended: true,
        goals: 3,
        assists: 0,
        weightDirection: 'same',
        foodTracking: false,
        hasStatRecord: true,
      }),
      p({
        gameId: 2,
        canonicalId: 'bob@id',
        displayName: 'Bob',
        attended: true,
        goals: 0,
        assists: 2,
        weightDirection: 'down',
        foodTracking: true,
        hasStatRecord: true,
      }),
      p({
        gameId: 3,
        canonicalId: 'alice@id',
        displayName: 'Alice',
        attended: false,
        goals: 5,
        assists: 5,
        weightDirection: 'down',
        foodTracking: true,
        hasStatRecord: true,
      }),
    ],
  });
}

describe('spec-008/US-2 aggregatePlayers', () => {
  const byId = (canonicalId: string) =>
    aggregatePlayers(sharedRichSeason()).find((pl) => pl.canonicalId === canonicalId)!;

  it('uses attended games as the denominator; an attended-no-stat game counts as 0 (A5, FR-004, FR-007)', () => {
    const alice = byId('alice@id');
    expect(alice.attendedGames).toBe(2); // g1, g2 — NOT the non-attended g3
    expect(alice.totalGoals).toBe(5); // 2 + 3 (g3's 5 excluded — not attended)
    expect(alice.totalAssists).toBe(1);
    expect(alice.totalContributions).toBe(6);
    expect(alice.goalsPerGame).toBeCloseTo(5 / 2, 10);
    expect(alice.assistsPerGame).toBeCloseTo(1 / 2, 10);

    const bob = byId('bob@id');
    expect(bob.attendedGames).toBe(2); // g1 (no stat) + g2
    expect(bob.totalGoals).toBe(0);
    expect(bob.totalAssists).toBe(2);
    expect(bob.goalsPerGame).toBe(0); // attended-no-stat g1 contributes a 0 game
    expect(bob.assistsPerGame).toBeCloseTo(2 / 2, 10);
  });

  it('weight-loss rate = attended∧down / attendedGames, no exclusions (A6, FR-008)', () => {
    expect(byId('alice@id').weightLossRate).toBeCloseTo(1 / 2, 10); // g1 down, g2 same
    expect(byId('bob@id').weightLossRate).toBeCloseTo(1 / 2, 10); // g1 unknown, g2 down
  });

  it('food-tracking rate counts every attended game, missing food read as not-tracked (A7, FR-010)', () => {
    expect(byId('alice@id').foodTrackingRate).toBeCloseTo(1 / 2, 10); // g1 true, g2 false
    expect(byId('bob@id').foodTrackingRate).toBeCloseTo(1 / 2, 10); // g1 false (no stat), g2 true
  });

  it('attendance rate = Yes-count / pollFixtureCount (A8, FR-009, FR-015)', () => {
    expect(byId('alice@id').attendanceRate).toBeCloseTo(2 / 2, 10);
    expect(byId('bob@id').attendanceRate).toBeCloseTo(2 / 2, 10);
    expect(byId('carol@id').attendanceRate).toBe(0); // 0 Yes over 2 fixtures → 0, not null
  });

  it('rates are null when the player has zero attended games (A5, SC-004)', () => {
    const carol = byId('carol@id'); // stat line on g1 but never voted Yes
    expect(carol.attendedGames).toBe(0);
    expect(carol.goalsPerGame).toBeNull();
    expect(carol.assistsPerGame).toBeNull();
    expect(carol.weightLossRate).toBeNull();
    expect(carol.foodTrackingRate).toBeNull();
  });

  it('returns one element per canonical identity (A12, SC-006)', () => {
    const players = aggregatePlayers(sharedRichSeason());
    expect(players).toHaveLength(3);
    expect(new Set(players.map((pl) => pl.canonicalId)).size).toBe(3);
  });

  it('orders by goals highest-first by default (A13, FR-006)', () => {
    const ids = aggregatePlayers(sharedRichSeason()).map((pl) => pl.canonicalId);
    expect(ids[0]).toBe('alice@id'); // 5 goals
    expect(ids).toEqual(['alice@id', 'bob@id', 'carol@id']); // bob/carol both 0, stable insertion order
  });

  it('re-orders by a chosen metric, highest-first (A13, FR-006)', () => {
    const byAssists = aggregatePlayers(sharedRichSeason(), { rankBy: 'assists' }).map(
      (pl) => pl.canonicalId
    );
    expect(byAssists[0]).toBe('bob@id'); // 2 assists > alice 1 > carol 0
    expect(byAssists).toEqual(['bob@id', 'alice@id', 'carol@id']);
  });

  it('sorts players with a null metric value last (A13)', () => {
    const byWeightLoss = aggregatePlayers(sharedRichSeason(), { rankBy: 'weightloss' });
    expect(byWeightLoss[byWeightLoss.length - 1]!.canonicalId).toBe('carol@id'); // null WL → last
  });
});

describe('spec-008/US-4 aggregateReport', () => {
  it('returns exactly aggregateSeason + default-ranked aggregatePlayers, no divergence (A15, FR-013)', () => {
    const input = sharedRichSeason();
    const report = aggregateReport(input);
    expect(report.season).toEqual(aggregateSeason(input));
    expect(report.players).toEqual(aggregatePlayers(input));
  });
});

describe('spec-008/US-3 aggregateAttendance', () => {
  it('per-player attendance = Yes-count / pollFixtureCount, eligible == pollFixtureCount (A8)', () => {
    const report = aggregateAttendance(sharedRichSeason());
    const find = (id: string) => report.players.find((pl) => pl.canonicalId === id)!;
    expect(find('alice@id').attended).toBe(2);
    expect(find('alice@id').eligible).toBe(2);
    expect(find('alice@id').attendanceRate).toBeCloseTo(2 / 2, 10);
    expect(find('carol@id').attended).toBe(0);
    expect(find('carol@id').eligible).toBe(2);
  });

  it('reports the squad average turnout per completed poll-bearing fixture (A10, FR-015)', () => {
    expect(aggregateAttendance(sharedRichSeason()).averageTurnoutPerFixture).toBe(2); // 4 Yes / 2
  });

  it('null turnout and null per-player rates when there are no poll fixtures (A8, SC-004)', () => {
    const report = aggregateAttendance(makeInput());
    expect(report.hasData).toBe(false);
    expect(report.averageTurnoutPerFixture).toBeNull();
  });
});
