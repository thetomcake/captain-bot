import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { PollService } from '../../services/poll-service.js';
import {
  formatFixturesTable,
  formatFixturesJSON,
  formatFixturesWithResponsesTable,
  formatFixturesWithResponsesJSON,
} from '../output/formatters.js';

export interface FixturesOptions {
  all?: boolean;
  season?: number;
  json?: boolean;
  /** US6 (FR-030): list each fixture's recorded poll responses beneath it. View-only, no Gateway. */
  showResponses?: boolean;
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
        if (options.json) {
          console.log(JSON.stringify({ error: `Season ${options.season} not found` }));
        } else {
          console.error(`Error: Season ${options.season} not found`);
        }
        process.exit(2);
      }
    } else {
      season = await seasonService.getCurrentSeason(teamId);

      if (!season) {
        if (options.json) {
          console.log(JSON.stringify({ error: 'No current season found. Run "captain-stats init" first.' }));
        } else {
          console.error('Error: No current season found. Run "captain-stats init" first.');
        }
        process.exit(3);
      }
    }

    // Get fixtures
    const fixtures = options.all
      ? await fixtureService.getFixtures(season.id)
      : await fixtureService.getUpcomingFixtures(season.id);

    if (fixtures.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'No fixtures found' }));
      } else {
        console.error('No fixtures found');
      }
      process.exit(1);
    }

    // Output - pure JSON or formatted table. `--show-responses` (US6) groups each fixture's poll
    // responses beneath it; the default path is left exactly as it was (AS-5).
    if (options.showResponses) {
      const pollService = new PollService(db);
      const responsesByGame = await pollService.getResponsesForGames(fixtures.map((f) => f.id));
      if (options.json) {
        console.log(formatFixturesWithResponsesJSON(season, fixtures, responsesByGame));
      } else {
        console.log(formatFixturesWithResponsesTable(season, fixtures, responsesByGame));
      }
    } else if (options.json) {
      // Pure JSON output - no decorative characters
      console.log(formatFixturesJSON(season, fixtures));
    } else {
      console.log(formatFixturesTable(season, fixtures));
    }

    process.exit(0);
  } catch (error) {
    // Database and other errors exit with code 3
    if (options.json) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    } else {
      console.error('Error:', error instanceof Error ? error.message : String(error));
    }
    process.exit(3);
  }
}
