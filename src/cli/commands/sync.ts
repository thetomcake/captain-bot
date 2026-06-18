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

    // Fetch fixtures into the current season. Season rollover is manual (FR-011) — the next season
    // is started by `end-of-season`, then lazily created on the following fetch (FR-012); a sync
    // never transitions seasons on its own.
    const games = await fixtureService.fetchFixtures(teamId);

    console.log(`✓ Synced ${games.length} fixtures`);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(3);
  }
}
