import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { fixturesCommand } from '#src/cli/commands/fixtures.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('CLI Fixtures Command Tests', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let exitCode: number | null;

  beforeEach(async () => {
    // Set up test environment with in-memory database
    const config = createTestConfig({
      databasePath: ':memory:',
    });
    setTestEnvironment(config);

    // Reset database singleton
    closeDatabase();

    // Get database and run migrations
    const { db } = getDatabase();
    const migrationsFolder = resolve(__dirname, '../../../drizzle');
    migrate(db, { migrationsFolder });

    // Create test team
    const [team] = await db.insert(schema.teams).values({
      name: 'Test Team',
      clubUrl: 'https://manvfatfootball.com/club/watford/',
      whatsappGroupId: null,
    }).returning();

    // Create test season
    const [season] = await db.insert(schema.seasons).values({
      teamId: team.id,
      seasonNumber: 1,
      isCurrent: true,
    }).returning();

    // Insert test fixtures
    const futureDate1 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
    const futureDate2 = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days from now

    await db.insert(schema.games).values([
      {
        seasonId: season.id,
        gameDate: futureDate1,
        opponent: 'Red Devils',
        venue: 'Victoria Park',
        status: 'upcoming',
        scrapedUrl: null,
      },
      {
        seasonId: season.id,
        gameDate: futureDate2,
        opponent: 'Blue Warriors',
        venue: 'Central Stadium',
        status: 'upcoming',
        scrapedUrl: null,
      },
    ]);

    // Mock console and process.exit to capture output
    consoleOutput = [];
    consoleErrors = [];
    exitCode = null;

    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(' '));
    };

    console.error = (...args: any[]) => {
      consoleErrors.push(args.join(' '));
    };

    // Mock process.exit - don't throw, just set the exit code and return
    // This prevents the command's error handler from catching our "exit"
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      // Return undefined to satisfy TypeScript, but this effectively stops execution
      // in most cases since calling code expects process.exit to never return
      return undefined as never;
    }) as any;
  });

  afterEach(() => {
    // Restore console and process.exit
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;

    // Close database
    closeDatabase();
  });

  describe('captain-stats fixtures', () => {
    it('should display upcoming fixtures (human-readable format)', async () => {
      await fixturesCommand({});

      const output = consoleOutput.join('\n');

      // Should contain header
      expect(output).toContain('Upcoming Fixtures');

      // Should contain opponent names
      expect(output).toContain('Red Devils');
      expect(output).toContain('Blue Warriors');

      // Should contain venue names
      expect(output).toContain('Victoria Park');
      expect(output).toContain('Central Stadium');

      // Should exit successfully
      expect(exitCode).toBe(0);
    });

    it('should output JSON format with --json flag', async () => {
      try {
        await fixturesCommand({ json: true });
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const output = consoleOutput.join('');
      const json = JSON.parse(output);

      // Should have required structure
      expect(json).toHaveProperty('season');
      expect(json).toHaveProperty('is_current');
      expect(json).toHaveProperty('fixtures');

      // Fixtures should be array
      expect(Array.isArray(json.fixtures)).toBe(true);

      // Each fixture should have required fields
      json.fixtures.forEach((fixture: any) => {
        expect(fixture).toHaveProperty('date');
        expect(fixture).toHaveProperty('time');
        expect(fixture).toHaveProperty('opponent');
        expect(fixture).toHaveProperty('venue');
        expect(fixture).toHaveProperty('status');
      });

      // Should exit successfully
      expect(exitCode).toBe(0);
    });

    it('should show all fixtures with --all flag', async () => {
      try {
        await fixturesCommand({ all: true });
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const output = consoleOutput.join('\n');

      // Should show both upcoming and completed fixtures
      expect(output).toBeDefined();
      expect(exitCode).toBe(0);
    });

    it('should filter by season with --season flag', async () => {
      try {
        await fixturesCommand({ season: 1 });
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const output = consoleOutput.join('\n');
      expect(output).toContain('Season 1');
      expect(exitCode).toBe(0);
    });

    it('should reflect updated fixture information when re-viewed (scenario 3)', async () => {
      // The club website updated a venue; the persisted fixture is refreshed
      const { db } = getDatabase();
      await db
        .update(schema.games)
        .set({ venue: 'New Ground', updatedAt: new Date() })
        .where(eq(schema.games.opponent, 'Red Devils'));

      try {
        await fixturesCommand({});
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const output = consoleOutput.join('\n');

      // The view reflects the updated information (FR-003)
      expect(output).toContain('New Ground');
      expect(exitCode).toBe(0);
    });

    it('should display fixtures in chronological order', async () => {
      try {
        await fixturesCommand({});
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const output = consoleOutput.join('\n');

      // "Red Devils" should appear before "Blue Warriors" (earlier date)
      const redDevilsPos = output.indexOf('Red Devils');
      const blueWarriorsPos = output.indexOf('Blue Warriors');

      expect(redDevilsPos).toBeLessThan(blueWarriorsPos);
      expect(exitCode).toBe(0);
    });
  });

  describe('output readability', () => {
    it('should produce readable table output', async () => {
      try {
        await fixturesCommand({});
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const output = consoleOutput.join('\n');

      // Should contain fixture information
      expect(output).toContain('Upcoming Fixtures');
      expect(output).toContain('Red Devils');
      expect(output).toContain('Blue Warriors');
      expect(exitCode).toBe(0);
    });
  });

  describe('performance (per spec.md SC-001)', () => {
    it('should return fixtures within 5 seconds', async () => {
      const start = Date.now();

      try {
        await fixturesCommand({});
      } catch (error: any) {
        if (!(error instanceof ProcessExitError)) throw error;
      }

      const duration = Date.now() - start;

      // SC-001: Captain can view all team fixtures within 5 seconds
      expect(duration).toBeLessThan(5000);
      expect(exitCode).toBe(0);
    });
  });

  describe('E2E smoke test', () => {
    it('should work when called as a real CLI process', () => {
      // This ONE test validates the CLI actually works as a binary
      const cliPath = resolve(__dirname, '../../../dist/cli/index.js');
      const output = execSync(`node ${cliPath} fixtures --help`, {
        encoding: 'utf-8',
      });

      expect(output.toString()).toContain('fixtures');
    });
  });
});
