import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../database/schema.js';
import { getCredentialKey, requireManvfatCredentials } from '../../config/env.js';
import { encryptSecret } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

export interface InitOptions {
  teamName?: string;
  clubUrl?: string;
}

/**
 * Init command - initialize database and create first team/season
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  try {
    const { db } = getDatabase();

    console.log('Initializing Captain Stats...');

    // Run migrations
    console.log('Running database migrations...');
    // Find project root (where drizzle/ is located) - go up from dist/cli/commands/
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const migrationsFolder = path.join(__dirname, '../../../drizzle');
    migrate(db, { migrationsFolder });

    console.log('✓ Database initialized');

    // Check if team already exists
    const [existingTeam] = await db.select().from(schema.teams).limit(1);

    if (existingTeam) {
      console.log('✓ Team already initialized');
      process.exit(0);
    }

    // Get team name and club URL from options or environment
    const teamName = options.teamName || process.env.TEAM_NAME || 'My Team';
    const clubUrl = options.clubUrl || process.env.CLUB_URL;

    if (!clubUrl) {
      console.error(
        'Error: CLUB_URL not set. Please set CLUB_URL in .env file or pass --club-url flag'
      );
      process.exit(2);
    }

    // MAN v FAT portal credentials (feature 005, FR-010): the fixtures page is gated behind a
    // WordPress login, so credentials are seeded onto the team at init, mirroring CLUB_URL. Both
    // the credentials and the encryption key are sourced from the validated config layer (env.ts) —
    // not process.env directly. The username is stored in plaintext; the password is encrypted at
    // rest. Each helper throws ConfigError (→ exit 2 via the catch below) when its input is missing.
    const { username: manvfatUsername, password: manvfatPassword } = requireManvfatCredentials();
    const credentialKey = getCredentialKey();
    const encryptedPassword = encryptSecret(manvfatPassword, credentialKey);

    // Create team
    console.log(`Creating team: ${teamName}`);
    const [team] = await db
      .insert(schema.teams)
      .values({
        name: teamName,
        clubUrl,
        whatsappGroupId: null,
        manvfatUsername,
        manvfatPassword: encryptedPassword,
      })
      .returning();

    if (!team) {
      throw new Error('Failed to create team');
    }

    console.log(`✓ Team created (ID: ${team.id})`);

    // Create first season
    const seasonService = new SeasonService(db);
    const season = await seasonService.getOrCreateCurrentSeason(team.id);

    console.log(`✓ Season ${season.seasonNumber} created`);

    // Fetch initial fixtures
    console.log('Fetching initial fixtures...');
    const fixtureService = new FixtureService(db, seasonService);
    const fixtures = await fixtureService.fetchFixtures(team.id);

    console.log(`✓ Fetched ${fixtures.length} fixtures`);

    console.log('\nInitialization complete!');
    console.log(`Run "captain-stats fixtures" to view upcoming games`);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    // Use the error's declared exit code when it is a known AppError (e.g. a missing/invalid
    // MANVFAT_CREDENTIAL_KEY raises ConfigError → exit 2); fall back to 3 otherwise.
    process.exit(error instanceof AppError ? error.statusCode : 3);
  }
}
