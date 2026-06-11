import { Game, Season } from '../../types/entities.js';

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
