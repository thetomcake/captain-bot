import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';

export interface SyncOptions {
  teamId?: number;
}

/**
 * Sync command - fetch and sync fixtures from club website
 */
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
    const { db } = getDatabase();
    const seasonService = new SeasonService(db);
    const fixtureService = new FixtureService(db, seasonService);

    // Get team ID (for now, assume team ID is 1)
    const teamId = options.teamId || 1;

    console.log('Syncing fixtures from club website...');

    // Fetch and sync fixtures (also detects season transitions, FR-005)
    const result = await fixtureService.syncFixtures(teamId);

    if (result.seasonTransition) {
      console.log(
        `✓ Season transition detected — started season ${result.newSeasonNumber} (previous season preserved)`
      );
    }
    console.log(`✓ Synced ${result.games.length} fixtures`);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(3);
  }
}
