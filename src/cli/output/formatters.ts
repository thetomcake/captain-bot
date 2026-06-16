import { Game, Season } from '../../types/entities.js';
import type { PlayerStatLine } from '../../services/stat-service.js';
import type { GamePollResponses } from '../../services/poll-service.js';

/**
 * Format fixtures as a table for human-readable display
 */
export function formatFixturesTable(season: Season, fixtures: Game[]): string {
  const lines: string[] = [];

  // Header
  lines.push(`Upcoming Fixtures - Season ${season.seasonNumber}`);
  lines.push('');

  // Table header
  const header = `Date         Time   Opponent           Venue                Status`;
  const separator = `─`.repeat(header.length);

  lines.push(header);
  lines.push(separator);

  // Table rows
  for (const fixture of fixtures) {
    const date = formatDate(fixture.gameDate);
    const time = formatTime(fixture.gameDate);
    const opponent = fixture.opponent.padEnd(18);
    const venue = fixture.venue.padEnd(20);
    const status = capitalizeFirst(fixture.status);

    lines.push(`${date}   ${time}  ${opponent} ${venue} ${status}`);
  }

  return lines.join('\n');
}

/**
 * Format fixtures as JSON
 */
export function formatFixturesJSON(season: Season, fixtures: Game[]): string {
  const output = {
    season: season.seasonNumber,
    is_current: season.isCurrent,
    fixtures: fixtures.map(f => ({
      id: f.id,
      date: formatDate(f.gameDate),
      time: formatTime(f.gameDate),
      opponent: f.opponent,
      venue: f.venue,
      status: f.status,
    })),
  };

  return JSON.stringify(output, null, 2);
}

// ── Fixtures + poll responses (US6, view-only — FR-030) ──────────────────────

/**
 * Format fixtures with each one's poll responses grouped beneath it (the `--show-responses` view,
 * FR-030). Additive — `formatFixturesTable` is left untouched (AS-5). A fixture absent from the
 * map has no poll (`(no poll posted)`, AS-2); a present fixture with no responses prints
 * `(no responses yet)` (AS-3). Voter name falls back to the canonical identity (AS-4), mirroring
 * the stats view.
 */
export function formatFixturesWithResponsesTable(
  season: Season,
  fixtures: Game[],
  responsesByGame: Map<number, GamePollResponses>
): string {
  const out: string[] = [`Fixtures - Season ${season.seasonNumber}`, ''];

  for (const fixture of fixtures) {
    const date = formatDate(fixture.gameDate);
    const time = formatTime(fixture.gameDate);
    out.push(`${date} ${time}  vs ${fixture.opponent}  (${fixture.venue})  ${capitalizeFirst(fixture.status)}`);

    const poll = responsesByGame.get(fixture.id);
    if (!poll) {
      out.push('  (no poll posted)');
    } else if (poll.responses.length === 0) {
      out.push('  (no responses yet)');
    } else {
      for (const r of poll.responses) {
        const name = r.displayName ?? r.canonicalId;
        out.push(`  ${name.padEnd(24)} ${r.selectedOption}`);
      }
    }
    out.push('');
  }

  return out.join('\n').trimEnd();
}

/**
 * Format fixtures with poll responses as JSON (AS-6). Each fixture object gains a `poll` field —
 * `null` when there is no poll, or `{ question, responses: [{ name, choice }] }`. Additive —
 * `formatFixturesJSON` is left untouched (AS-5).
 */
export function formatFixturesWithResponsesJSON(
  season: Season,
  fixtures: Game[],
  responsesByGame: Map<number, GamePollResponses>
): string {
  const output = {
    season: season.seasonNumber,
    is_current: season.isCurrent,
    fixtures: fixtures.map((f) => {
      const poll = responsesByGame.get(f.id);
      return {
        id: f.id,
        date: formatDate(f.gameDate),
        time: formatTime(f.gameDate),
        opponent: f.opponent,
        venue: f.venue,
        status: f.status,
        poll: poll
          ? {
              question: poll.pollQuestion,
              responses: poll.responses.map((r) => ({
                name: r.displayName ?? r.canonicalId,
                choice: r.selectedOption,
              })),
            }
          : null,
      };
    }),
  };

  return JSON.stringify(output, null, 2);
}

// ── Stats (US4, view-only) ──────────────────────────────────────────────────

/** A player's stat lines grouped together with season totals. */
interface PlayerGroup {
  canonicalId: string;
  displayName: string | null;
  totalGoals: number;
  totalAssists: number;
  games: PlayerStatLine[];
}

/**
 * Group flat stat lines by canonical identity, summing goals/assists for the season total. Lines
 * arrive ordered by player then game date, so first-seen order is preserved.
 */
function groupByPlayer(lines: PlayerStatLine[]): PlayerGroup[] {
  const groups = new Map<string, PlayerGroup>();
  for (const line of lines) {
    let group = groups.get(line.canonicalId);
    if (!group) {
      group = {
        canonicalId: line.canonicalId,
        displayName: line.displayName,
        totalGoals: 0,
        totalAssists: 0,
        games: [],
      };
      groups.set(line.canonicalId, group);
    }
    group.totalGoals += line.goals;
    group.totalAssists += line.assists;
    group.games.push(line);
  }
  return [...groups.values()];
}

/**
 * Format stats grouped by player for human-readable display. `heading` names the scope
 * (e.g. "Game 5" or "Season 2").
 */
export function formatStatsTable(heading: string, lines: PlayerStatLine[]): string {
  const out: string[] = [`Stats - ${heading}`, ''];

  for (const player of groupByPlayer(lines)) {
    const name = player.displayName ?? player.canonicalId;
    out.push(`${name}  (goals ${player.totalGoals}, assists ${player.totalAssists})`);
    for (const g of player.games) {
      const weight = g.weightDirection ?? 'unknown';
      const food = g.foodTracking ? 'yes' : 'no';
      out.push(
        `  ${formatDate(g.gameDate)}  vs ${g.opponent}  ` +
          `goals ${g.goals}  assists ${g.assists}  weight ${weight}  food ${food}`
      );
    }
    out.push('');
  }

  return out.join('\n').trimEnd();
}

/** Format stats grouped by player as JSON. */
export function formatStatsJSON(lines: PlayerStatLine[]): string {
  const players = groupByPlayer(lines).map((player) => ({
    canonicalId: player.canonicalId,
    displayName: player.displayName,
    totalGoals: player.totalGoals,
    totalAssists: player.totalAssists,
    games: player.games.map((g) => ({
      gameId: g.gameId,
      opponent: g.opponent,
      date: formatDate(g.gameDate),
      goals: g.goals,
      assists: g.assists,
      weightDirection: g.weightDirection,
      foodTracking: g.foodTracking,
    })),
  }));

  return JSON.stringify({ players }, null, 2);
}

// ── Seasons (US4 — FR-004) ───────────────────────────────────────────────────

/** Format the season history as a human-readable list. */
export function formatSeasonsTable(seasons: Season[]): string {
  const out: string[] = ['Seasons', ''];
  for (const s of seasons) {
    const range = `${s.startDate ? formatDate(s.startDate) : '—'} to ${
      s.endDate ? formatDate(s.endDate) : '—'
    }`;
    const current = s.isCurrent ? '  (current)' : '';
    out.push(`Season ${s.seasonNumber}  ${range}${current}`);
  }
  return out.join('\n');
}

/** Format the season history as JSON (number, date range, current flag). */
export function formatSeasonsJSON(seasons: Season[]): string {
  const output = {
    seasons: seasons.map((s) => ({
      season: s.seasonNumber,
      start: s.startDate ? formatDate(s.startDate) : null,
      end: s.endDate ? formatDate(s.endDate) : null,
      current: s.isCurrent,
    })),
  };
  return JSON.stringify(output, null, 2);
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Format time as HH:MM
 */
function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}

/**
 * Capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
