import type {
  AttendanceReport,
  PlayerAggregate,
  RankMetric,
  SeasonAggregate,
} from '../../stats/aggregations.js';

/** Per-game rate to a fixed number of decimals; a null rate ("not applicable") renders `n/a`. */
function decimal(value: number | null, digits: number): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

/** A fraction (0..1) as a whole-number percentage; a null rate renders `n/a`. */
function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

/** Human-readable team season summary. */
export function formatSeasonSummaryTable(s: SeasonAggregate): string {
  const { completed, cancelled, upcoming } = s.gamesByStatus;
  return [
    `${s.scopeLabel} — Team Summary`,
    '',
    `Games:         ${completed} completed, ${cancelled} cancelled, ${upcoming} upcoming`,
    `Goals:         ${s.totalGoals} (${decimal(s.goalsPerGame, 2)} per completed game)`,
    `Assists:       ${s.totalAssists} (${decimal(s.assistsPerGame, 2)} per completed game)`,
    `Squad size:    ${s.squadSize} players`,
    `Avg turnout:   ${decimal(s.averageTurnoutPerFixture, 1)} per fixture`,
    `Weight-loss:   ${percent(s.squadWeightLossRate)}  (squad avg of per-player rates)`,
    `Food tracking: ${percent(s.squadFoodTrackingRate)}  (squad avg of per-player rates)`,
  ].join('\n');
}

/** Team season summary as JSON — the {@link SeasonAggregate} shape verbatim (null rates stay null). */
export function formatSeasonSummaryJSON(s: SeasonAggregate): string {
  return JSON.stringify(s, null, 2);
}

/** A player's display name, falling back to the canonical id when no name is known. */
function name(p: { displayName: string | null; canonicalId: string }): string {
  return p.displayName ?? p.canonicalId;
}

/** Right-pad to a column width (the terminal table views may align; the chat report may not). */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Left-pad to a column width for right-aligned numeric columns. */
function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/**
 * Per-player leaderboard as an aligned terminal table (alignment is fine here — unlike the chat
 * report). Null rates render `n/a` (never `0`/`NaN` — SC-004).
 */
export function formatPlayerAggregatesTable(
  scopeLabel: string,
  rankBy: RankMetric,
  players: PlayerAggregate[]
): string {
  const nameWidth = Math.max(6, ...players.map((p) => name(p).length));
  const header =
    pad('Player', nameWidth) +
    ['G', 'A', 'GC', 'Att', 'G/Att', 'A/Att', 'Att%', 'WL%', 'Food%']
      .map((h) => padStart(h, h === 'G/Att' || h === 'A/Att' ? 7 : 6))
      .join('');

  const rows = players.map(
    (p) =>
      pad(name(p), nameWidth) +
      padStart(String(p.totalGoals), 6) +
      padStart(String(p.totalAssists), 6) +
      padStart(String(p.totalContributions), 6) +
      padStart(String(p.attendedGames), 6) +
      padStart(decimal(p.goalsPerGame, 2), 7) +
      padStart(decimal(p.assistsPerGame, 2), 7) +
      padStart(percent(p.attendanceRate), 6) +
      padStart(percent(p.weightLossRate), 6) +
      padStart(percent(p.foodTrackingRate), 6)
  );

  return [`${scopeLabel} — Players (ranked by ${rankBy})`, '', header, ...rows].join('\n');
}

/** Per-player leaderboard as JSON: `{ season, rankBy, players }` (null rates stay null). */
export function formatPlayerAggregatesJSON(
  scopeLabel: string,
  rankBy: RankMetric,
  players: PlayerAggregate[]
): string {
  return JSON.stringify({ season: scopeLabel, rankBy, players }, null, 2);
}

/**
 * Attendance / turnout as an aligned terminal table: per-player attended/eligible and attendance %,
 * with the squad average turnout in the heading.
 */
export function formatAttendanceTable(report: AttendanceReport): string {
  const nameWidth = Math.max(6, ...report.players.map((p) => name(p).length));
  const header = pad('Player', nameWidth) + padStart('Attended/Eligible', 19) + padStart('Att%', 8);
  const rows = report.players.map(
    (p) =>
      pad(name(p), nameWidth) +
      padStart(`${p.attended}/${p.eligible}`, 19) +
      padStart(percent(p.attendanceRate), 8)
  );
  return [
    `${report.scopeLabel} — Attendance   (avg turnout ${decimal(
      report.averageTurnoutPerFixture,
      1
    )} per fixture)`,
    '',
    header,
    ...rows,
  ].join('\n');
}

/** Attendance report as JSON — the {@link AttendanceReport} shape verbatim. */
export function formatAttendanceJSON(report: AttendanceReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * The shareable chat report (FR-016): a single contiguous block of plain `Label: value` lines plus
 * one line per attended player. **No fixed-width columns, box-drawing, ANSI, or pager** — WhatsApp
 * renders a proportional font that breaks aligned tables. Only attended players appear (FR-017).
 */
export function formatReportBlock(report: {
  season: SeasonAggregate;
  players: PlayerAggregate[];
}): string {
  const { season, players } = report;
  const attended = players.filter((p) => p.attendedGames > 0);

  const lines = [
    `${season.scopeLabel} — Team Report`,
    '',
    `Avg attendance/game: ${decimal(season.averageTurnoutPerFixture, 1)}`,
    `Goals: ${season.totalGoals}  (avg ${decimal(season.goalsPerGame, 2)}/game)`,
    `Assists: ${season.totalAssists}  (avg ${decimal(season.assistsPerGame, 2)}/game)`,
    `Avg weight-loss/week: ${percent(season.squadWeightLossRate)}`,
    `Avg food-tracking/week: ${percent(season.squadFoodTrackingRate)}`,
    '',
    'Players (attended players only):',
  ];

  for (const p of attended) {
    lines.push(
      `- ${name(p)} — ${decimal(p.goalsPerGame, 2)} goals, ${decimal(
        p.assistsPerGame,
        2
      )} assists per game · food ${percent(p.foodTrackingRate)} · weight-loss ${percent(
        p.weightLossRate
      )}`
    );
  }

  return lines.join('\n');
}

/** The shareable report as JSON — `{ season, players }` (FR-013 reuse shape). */
export function formatReportJSON(report: {
  season: SeasonAggregate;
  players: PlayerAggregate[];
}): string {
  return JSON.stringify(report, null, 2);
}
