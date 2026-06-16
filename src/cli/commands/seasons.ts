import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { formatSeasonsTable, formatSeasonsJSON } from '../output/formatters.js';

export interface SeasonsOptions {
  json?: boolean;
}

/**
 * Seasons command (T039, US4 — FR-004) — list the season history (number, date range, current
 * flag) so a previous season can be selected for `fixtures`/`stats` (SC-006). View-only.
 *
 * Exit codes (cli-commands.md): `0` success · `1` empty (no seasons).
 */
export async function seasonsCommand(options: SeasonsOptions = {}): Promise<void> {
  try {
    const { db } = getDatabase();
    const seasonService = new SeasonService(db);
    const teamId = 1;

    const seasons = await seasonService.getSeasons(teamId);

    if (seasons.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'No seasons found' }));
      } else {
        console.error('Error: No seasons found. Run "captain-stats init" first.');
      }
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(formatSeasonsJSON(seasons));
    } else {
      console.log(formatSeasonsTable(seasons));
    }
    process.exit(0);
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    } else {
      console.error('Error:', error instanceof Error ? error.message : String(error));
    }
    process.exit(3);
  }
}
