import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { StatService, type PlayerStatLine } from '../../services/stat-service.js';
import { formatStatsTable, formatStatsJSON } from '../output/formatters.js';

export interface StatsOptions {
  game?: number;
  season?: number;
  json?: boolean;
}

/**
 * Stats command (T038, US4) — view stored stats grouped by player (canonical identity) for a
 * single game (`--game`) or a whole season (`--season`). View-only: there is no captain-side
 * correction (FR-024); stored stats change only via a later player message (FR-019). Works for
 * past seasons (FR-023, SC-006/SC-007).
 *
 * Exit codes (cli-commands.md): `0` success · `1` not-found/empty · `2` missing selector arg.
 */
export async function statsCommand(options: StatsOptions = {}): Promise<void> {
  try {
    if (options.game === undefined && options.season === undefined) {
      emit(options.json, { error: 'Specify --game <id> or --season <n>' });
      process.exit(2);
      return;
    }

    const { db } = getDatabase();
    const statService = new StatService(db);
    const teamId = 1;

    let lines: PlayerStatLine[];
    let heading: string;

    if (options.game !== undefined) {
      lines = await statService.getStatsByGame(options.game);
      heading = `Game ${options.game}`;
    } else {
      const seasonService = new SeasonService(db);
      const seasons = await seasonService.getSeasons(teamId);
      const season = seasons.find((s) => s.seasonNumber === options.season);
      if (!season) {
        emit(options.json, { error: `Season ${options.season} not found` });
        process.exit(1);
        return;
      }
      lines = await statService.getStatsBySeason(season.id);
      heading = `Season ${season.seasonNumber}`;
    }

    if (lines.length === 0) {
      emit(options.json, { error: 'No stats found' });
      process.exit(1);
      return;
    }

    if (options.json) {
      console.log(formatStatsJSON(lines));
    } else {
      console.log(formatStatsTable(heading, lines));
    }
    process.exit(0);
  } catch (error) {
    emit(options.json, { error: error instanceof Error ? error.message : String(error) });
    process.exit(3);
  }
}

/** Write an error payload to the appropriate stream for the chosen output mode. */
function emit(json: boolean | undefined, payload: { error: string }): void {
  if (json) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(`Error: ${payload.error}`);
  }
}
