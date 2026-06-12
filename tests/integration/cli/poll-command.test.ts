import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { pollCommand } from '#src/cli/commands/poll.js';
import { MockWhatsAppClient } from '../../helpers/mock-whatsapp.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('CLI Poll Command Tests', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let exitCode: number | null;
  let mockClient: MockWhatsAppClient;

  beforeEach(async () => {
    const config = createTestConfig({
      databasePath: ':memory:',
      authorizedGroupId: 'test-group@g.us',
    });
    setTestEnvironment(config);

    closeDatabase();

    const { db } = getDatabase();
    const migrationsFolder = resolve(__dirname, '../../../drizzle');
    migrate(db, { migrationsFolder });

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();

    const [season] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(schema.games).values({
      seasonId: season!.id,
      gameDate: futureDate,
      opponent: 'Red Devils',
      venue: 'Victoria Park',
      status: 'upcoming',
      scrapedUrl: null,
    });

    mockClient = new MockWhatsAppClient();

    consoleOutput = [];
    consoleErrors = [];
    exitCode = null;

    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.join(' '));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.join(' '));
    };
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as typeof process.exit;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    closeDatabase();
  });

  describe('--dry-run mode', () => {
    it('should show game info without sending poll', async () => {
      await pollCommand({ dryRun: true }, mockClient);

      const output = consoleOutput.join('\n');
      expect(output).toContain('Red Devils');
      expect(mockClient.sentPolls).toHaveLength(0);
      expect(exitCode).toBe(0);
    });

    it('should not store poll in database during dry run', async () => {
      await pollCommand({ dryRun: true }, mockClient);

      const { db } = getDatabase();
      const polls = await db.select().from(schema.polls);
      expect(polls).toHaveLength(0);
    });
  });

  describe('posting poll', () => {
    it('should send poll and report success', async () => {
      await pollCommand({}, mockClient);

      expect(mockClient.sentPolls).toHaveLength(1);
      const output = consoleOutput.join('\n');
      expect(output).toContain('Red Devils');
      expect(exitCode).toBe(0);
    });

    it('should exit 2 if poll already posted without --force', async () => {
      await pollCommand({}, mockClient);
      exitCode = null;

      await pollCommand({}, mockClient);

      expect(exitCode).toBe(2);
      expect(mockClient.sentPolls).toHaveLength(1);
    });

    it('should re-post with --force', async () => {
      await pollCommand({}, mockClient);
      exitCode = null;

      await pollCommand({ force: true }, mockClient);

      expect(exitCode).toBe(0);
      expect(mockClient.sentPolls).toHaveLength(2);
    });

    it('should leave exactly one poll row for the game after --force (no duplicates)', async () => {
      await pollCommand({}, mockClient);
      exitCode = null;

      await pollCommand({ force: true }, mockClient);

      expect(exitCode).toBe(0);
      const { db } = getDatabase();
      const polls = await db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
    });
  });

  describe('exit codes', () => {
    it('should exit 0 on success', async () => {
      await pollCommand({}, mockClient);
      expect(exitCode).toBe(0);
    });

    it('should exit 1 when no upcoming games', async () => {
      const { db } = getDatabase();
      await db.update(schema.games).set({ status: 'completed' });

      await pollCommand({}, mockClient);

      expect(exitCode).toBe(1);
    });

    it('should exit 2 if poll already posted (no --force)', async () => {
      await pollCommand({}, mockClient);
      exitCode = null;
      await pollCommand({}, mockClient);

      expect(exitCode).toBe(2);
    });

    it('should exit 3 when WhatsApp group not configured', async () => {
      setTestEnvironment(
        createTestConfig({ databasePath: ':memory:', authorizedGroupId: undefined })
      );

      await pollCommand({}, mockClient);
      expect(exitCode).toBe(3);
    });
  });

  describe('output format', () => {
    it('should include game details in output', async () => {
      await pollCommand({}, mockClient);

      const output = consoleOutput.join('\n');
      expect(output).toContain('Red Devils');
      expect(output).toContain('Victoria Park');
    });
  });
});
