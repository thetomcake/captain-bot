/**
 * Pure, DB- and CLI-agnostic season roll-up core. Given an {@link AggregationInput} of
 * already-fetched rows it returns derived aggregates — no Drizzle, no I/O, no formatting — so any
 * surface that can build the input (the `stats` CLI now, a chat summary later) gets identical
 * figures.
 */

export type RankMetric =
  | 'goals'
  | 'assists'
  | 'contributions'
  | 'attendance'
  | 'weightloss'
  | 'foodtracking';

export interface GameStatus {
  gameId: number;
  status: 'upcoming' | 'completed' | 'cancelled';
}

export interface Participation {
  gameId: number;
  canonicalId: string;
  displayName: string | null;
  /** Voted "Yes" on this completed game's poll — the per-player denominator everywhere. */
  attended: boolean;
  goals: number;
  assists: number;
  weightDirection: 'up' | 'down' | 'same' | 'unknown' | null;
  /**
   * Defaults to false: a null/missing food field is read as "not tracked", the same default as
   * `goals → 0`. Food tracking has no "unknown" state, unlike weight direction.
   */
  foodTracking: boolean;
  hasStatRecord: boolean;
}

export interface AggregationInput {
  scopeLabel: string;
  /** Every game in the season, all statuses — for the games-by-status counts. */
  games: GameStatus[];
  /** Completed games in the season that have a poll — the attendance denominator. */
  pollFixtureCount: number;
  /** One row per (completed game, player) the player attended or has a stat line for. */
  participation: Participation[];
}

export interface SeasonAggregate {
  scopeLabel: string;
  hasData: boolean;
  totalGoals: number;
  totalAssists: number;
  gamesByStatus: { completed: number; cancelled: number; upcoming: number };
  goalsPerGame: number | null;
  assistsPerGame: number | null;
  squadSize: number;
  averageTurnoutPerFixture: number | null;
  squadWeightLossRate: number | null;
  squadFoodTrackingRate: number | null;
}

export interface PlayerAggregate {
  canonicalId: string;
  displayName: string | null;
  totalGoals: number;
  totalAssists: number;
  totalContributions: number;
  attendedGames: number;
  goalsPerGame: number | null;
  assistsPerGame: number | null;
  attendanceRate: number | null;
  weightLossRate: number | null;
  foodTrackingRate: number | null;
}

export interface AttendanceReport {
  scopeLabel: string;
  hasData: boolean;
  averageTurnoutPerFixture: number | null;
  players: {
    canonicalId: string;
    displayName: string | null;
    attendanceRate: number | null;
    attended: number;
    eligible: number;
  }[];
}

/**
 * The single rate helper honoured by every aggregate: a zero denominator yields `null`
 * ("not applicable"), never `NaN`, `Infinity`, or a misleading `0`.
 */
export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Per-player aggregates over each player's ATTENDED games (the uniform denominator). One element
 * per canonical identity. Shared by the season summary (squad means) and the per-player view, so
 * both derive from one computation and cannot diverge.
 */
function computePlayers(input: AggregationInput): PlayerAggregate[] {
  interface Acc {
    canonicalId: string;
    displayName: string | null;
    attendedGames: number;
    goals: number;
    assists: number;
    down: number;
    food: number;
  }
  const byPlayer = new Map<string, Acc>();

  for (const row of input.participation) {
    let acc = byPlayer.get(row.canonicalId);
    if (!acc) {
      acc = {
        canonicalId: row.canonicalId,
        displayName: row.displayName,
        attendedGames: 0,
        goals: 0,
        assists: 0,
        down: 0,
        food: 0,
      };
      byPlayer.set(row.canonicalId, acc);
    }
    if (acc.displayName === null && row.displayName !== null) acc.displayName = row.displayName;
    if (!row.attended) continue;
    acc.attendedGames += 1;
    acc.goals += row.goals;
    acc.assists += row.assists;
    if (row.weightDirection === 'down') acc.down += 1;
    if (row.foodTracking) acc.food += 1;
  }

  return [...byPlayer.values()].map((a) => ({
    canonicalId: a.canonicalId,
    displayName: a.displayName,
    totalGoals: a.goals,
    totalAssists: a.assists,
    totalContributions: a.goals + a.assists,
    attendedGames: a.attendedGames,
    goalsPerGame: rate(a.goals, a.attendedGames),
    assistsPerGame: rate(a.assists, a.attendedGames),
    attendanceRate: rate(a.attendedGames, input.pollFixtureCount),
    weightLossRate: rate(a.down, a.attendedGames),
    foodTrackingRate: rate(a.food, a.attendedGames),
  }));
}

/** Mean of the non-null rates, or null when there are none (each value weighted equally). */
function meanOfRates(rates: (number | null)[]): number | null {
  const present = rates.filter((r): r is number => r !== null);
  return present.length === 0 ? null : present.reduce((sum, r) => sum + r, 0) / present.length;
}

/**
 * Team season summary. Totals sum over every completed-game stat record; per-completed-game rates
 * divide by completed games; squad lifestyle rates are the mean of per-player rates over attended
 * players. `hasData` is false only when the season has no completed games and no participation.
 */
export function aggregateSeason(input: AggregationInput): SeasonAggregate {
  const players = computePlayers(input);

  const gamesByStatus = { completed: 0, cancelled: 0, upcoming: 0 };
  for (const g of input.games) gamesByStatus[g.status] += 1;

  let totalGoals = 0;
  let totalAssists = 0;
  for (const row of input.participation) {
    if (!row.hasStatRecord) continue;
    totalGoals += row.goals;
    totalAssists += row.assists;
  }

  const attendedPlayers = players.filter((p) => p.attendedGames > 0);
  const totalYes = input.participation.filter((p) => p.attended).length;

  return {
    scopeLabel: input.scopeLabel,
    hasData: gamesByStatus.completed > 0 || input.participation.length > 0,
    totalGoals,
    totalAssists,
    gamesByStatus,
    goalsPerGame: rate(totalGoals, gamesByStatus.completed),
    assistsPerGame: rate(totalAssists, gamesByStatus.completed),
    squadSize: players.length,
    averageTurnoutPerFixture: rate(totalYes, input.pollFixtureCount),
    squadWeightLossRate: meanOfRates(attendedPlayers.map((p) => p.weightLossRate)),
    squadFoodTrackingRate: meanOfRates(attendedPlayers.map((p) => p.foodTrackingRate)),
  };
}

/** The {@link PlayerAggregate} field a rank metric orders by; the rate metrics may be `null`. */
function metricValue(p: PlayerAggregate, metric: RankMetric): number | null {
  switch (metric) {
    case 'goals':
      return p.totalGoals;
    case 'assists':
      return p.totalAssists;
    case 'contributions':
      return p.totalContributions;
    case 'attendance':
      return p.attendanceRate;
    case 'weightloss':
      return p.weightLossRate;
    case 'foodtracking':
      return p.foodTrackingRate;
  }
}

/**
 * Per-player aggregates, one element per canonical identity, ordered by `rankBy` (default `goals`)
 * highest-first. A `null` metric value (a rate with zero attended games) always sorts last; the
 * order is otherwise stable. Shares {@link computePlayers} with {@link aggregateSeason}, so the
 * leaderboard and the squad means can never diverge.
 */
export function aggregatePlayers(
  input: AggregationInput,
  opts: { rankBy?: RankMetric } = {}
): PlayerAggregate[] {
  const rankBy = opts.rankBy ?? 'goals';
  return computePlayers(input).sort((a, b) => {
    const av = metricValue(a, rankBy);
    const bv = metricValue(b, rankBy);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last
    if (bv === null) return -1;
    return bv - av; // highest first
  });
}

/**
 * Per-player attendance over the season's completed poll-bearing fixtures, plus the squad's average
 * turnout. `eligible` is `pollFixtureCount` for every player (poll-less / non-completed fixtures
 * never count); players are ordered most-attended first (stable).
 */
export function aggregateAttendance(input: AggregationInput): AttendanceReport {
  const players = computePlayers(input);
  const totalYes = input.participation.filter((p) => p.attended).length;
  return {
    scopeLabel: input.scopeLabel,
    hasData: input.pollFixtureCount > 0 || input.participation.length > 0,
    averageTurnoutPerFixture: rate(totalYes, input.pollFixtureCount),
    players: players
      .map((p) => ({
        canonicalId: p.canonicalId,
        displayName: p.displayName,
        attendanceRate: p.attendanceRate,
        attended: p.attendedGames,
        eligible: input.pollFixtureCount,
      }))
      .sort((a, b) => b.attended - a.attended),
  };
}

/**
 * Convenience for the shareable chat report (FR-013): exactly the team summary and the
 * default-ranked per-player aggregates, with no recomputation — the single source the report
 * formatter (and a future WhatsApp surface) renders.
 */
export function aggregateReport(input: AggregationInput): {
  season: SeasonAggregate;
  players: PlayerAggregate[];
} {
  return { season: aggregateSeason(input), players: aggregatePlayers(input) };
}
