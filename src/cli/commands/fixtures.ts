import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { formatFixturesTable, formatFixturesJSON } from '../output/formatters.js';

export interface FixturesOptions {
  all?: boolean;
  season?: number;
  json?: boolean;
}

/**
 * Fixtures command - display team fixtures
 */
export async function fixturesCommand(options: FixturesOptions = {}): Promise<void> {
  try {
    const { db } = getDatabase();
    const seasonService = new SeasonService(db);
    const fixtureService = new FixtureService(db, seasonService);

    // Get team ID (for now, assume team ID is 1; later this will come from config)
    const teamId = 1;

    // Get season
    let season;
    if (options.season) {
      const seasons = await seasonService.getSeasons(teamId);
      season = seasons.find(s => s.seasonNumber === options.season);

      if (!season) {
        console.error(`Error: Season ${options.season} not found`);
        process.exit(2);
      }
    } else {
      season = await seasonService.getCurrentSeason(teamId);

      if (!season) {
        console.error('Error: No current season found. Run "captain-stats init" first.');
        process.exit(3);
      }
    }

    // Get fixtures
    const fixtures = options.all
      ? await fixtureService.getFixtures(season.id)
      : await fixtureService.getUpcomingFixtures(season.id);

    if (fixtures.length === 0) {
      console.error('No fixtures found');
      process.exit(1);
    }

    // Output
    if (options.json) {
      console.log(formatFixturesJSON(season, fixtures));
    } else {
      console.log(formatFixturesTable(season, fixtures));
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(3);
  }
}
