import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { StatService, type PlayerStatLine } from '../../services/stat-service.js';
import { AggregateService } from '../../services/aggregate-service.js';
import type { RankMetric } from '../../stats/aggregations.js';
import { formatStatsTable, formatStatsJSON } from '../output/formatters.js';
import {
  formatSeasonSummaryTable,
  formatSeasonSummaryJSON,
  formatPlayerAggregatesTable,
  formatPlayerAggregatesJSON,
  formatAttendanceTable,
  formatAttendanceJSON,
  formatReportBlock,
  formatReportJSON,
} from '../output/aggregate-formatters.js';

/** Valid `--rank` metrics for the `--players` leaderboard (default `goals`). */
const RANK_METRICS: readonly RankMetric[] = [
  'goals',
  'assists',
  'contributions',
  'attendance',
  'weightloss',
  'foodtracking',
];

export interface StatsOptions {
  game?: number;
  season?: number;
  json?: boolean;
  summary?: boolean;
  players?: boolean;
  attendance?: boolean;
  report?: boolean;
  rank?: string;
}

/** The aggregate view flags, mutually exclusive with each other and with `--game`. */
type AggregateView = 'summary' | 'players' | 'attendance' | 'report';

/**
 * Stats command — view stored stats grouped by player for a single game (`--game`) or a season
 * (`--season`), or one of the season roll-up views (`--summary`/`--players`/`--attendance`/
 * `--report`). The legacy raw views are unchanged when no aggregate flag is present.
 *
 * Exit codes: `0` success · `1` season-not-found · `2` no-data or usage error · `3` unexpected.
 */
export async function statsCommand(options: StatsOptions = {}): Promise<void> {
  try {
    const { db } = getDatabase();

    const views: AggregateView[] = (['summary', 'players', 'attendance', 'report'] as const).filter(
      (v) => options[v]
    );
    if (views.length > 0) {
      await runAggregateView(db, views, options);
      return;
    }

    if (options.game === undefined && options.season === undefined) {
      emit(options.json, { error: 'Specify --game <id> or --season <n>' });
      process.exit(2);
      return;
    }

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

/**
 * Dispatch a single aggregate view: reject conflicting flags, resolve the season (default current,
 * not-found → exit 1), then render the chosen view (no-data → exit 2).
 */
async function runAggregateView(
  db: ReturnType<typeof getDatabase>['db'],
  views: AggregateView[],
  options: StatsOptions
): Promise<void> {
  if (views.length > 1 || options.game !== undefined) {
    emit(options.json, {
      error:
        'Choose a single view: --summary / --players / --attendance / --report are mutually exclusive and cannot combine with --game',
    });
    process.exit(2);
    return;
  }

  const service = new AggregateService(db);
  const resolution = await service.resolveSeason(options.season);
  if (resolution.kind === 'not-found') {
    const label = options.season !== undefined ? `Season ${options.season}` : 'Current season';
    emit(options.json, { error: `${label} not found` });
    process.exit(1);
    return;
  }
  const season = resolution.season;

  switch (views[0]) {
    case 'summary': {
      const summary = await service.getSeasonSummary(season.id);
      if (!summary.hasData) {
        emit(options.json, { error: `No data for season ${season.seasonNumber}` });
        process.exit(2);
        return;
      }
      console.log(
        options.json ? formatSeasonSummaryJSON(summary) : formatSeasonSummaryTable(summary)
      );
      process.exit(0);
      return;
    }
    case 'players': {
      const rankBy: RankMetric =
        options.rank === undefined ? 'goals' : (options.rank as RankMetric);
      if (options.rank !== undefined && !RANK_METRICS.includes(rankBy)) {
        emit(options.json, {
          error: `Unknown --rank metric '${options.rank}'. Choose one of: ${RANK_METRICS.join(', ')}`,
        });
        process.exit(2);
        return;
      }
      const players = await service.getPlayerAggregates(season.id, rankBy);
      if (players.length === 0) {
        emit(options.json, { error: `No data for season ${season.seasonNumber}` });
        process.exit(2);
        return;
      }
      const scopeLabel = `Season ${season.seasonNumber}`;
      console.log(
        options.json
          ? formatPlayerAggregatesJSON(scopeLabel, rankBy, players)
          : formatPlayerAggregatesTable(scopeLabel, rankBy, players)
      );
      process.exit(0);
      return;
    }
    case 'report': {
      const report = await service.getReport(season.id);
      if (!report.season.hasData) {
        emit(options.json, { error: `No data for season ${season.seasonNumber}` });
        process.exit(2);
        return;
      }
      console.log(options.json ? formatReportJSON(report) : formatReportBlock(report));
      process.exit(0);
      return;
    }
    case 'attendance': {
      const report = await service.getAttendance(season.id);
      if (!report.hasData) {
        emit(options.json, { error: `No data for season ${season.seasonNumber}` });
        process.exit(2);
        return;
      }
      console.log(options.json ? formatAttendanceJSON(report) : formatAttendanceTable(report));
      process.exit(0);
      return;
    }
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
