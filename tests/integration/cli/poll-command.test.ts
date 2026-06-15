import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { pollCommand } from '#src/cli/commands/poll.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';
import { FakeGateway } from '../../helpers/fake-gateway.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Poll command reworked onto the Gateway port (T025/T030).
 *
 * The command re-fetches fixtures on demand (FR-003). Every fetch goes through MockFixtureScraper
 * backed by the static `manvfat-fixtures.html` — no real network. The "no confirmed next fixture"
 * case uses a placeholder-only HTML snippet (mirrors the file's "Fixtures to be confirmed" rows),
 * so the scrape yields zero fixtures without fetching real data.
 */
const PLACEHOLDER_ONLY_HTML = `
<div class="week"><div class="inner">
  <div class="group-header white">Week 7 - June 29th</div>
  <table class="fixture-table">
    <tr class="no-highlight"><td colspan="6" class="subtitle">Fixtures to be confirmed</td></tr>
  </table>
</div></div>`;

describe('CLI Poll Command (Gateway-native)', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let exitCode: number | null;
  let gateway: FakeGateway;

  /** Build a FixtureService bound to the singleton DB and the given static HTML. */
  function fixtureServiceWith(html?: string): FixtureService {
    const { db } = getDatabase();
    return new FixtureService(db, new SeasonService(db), new MockFixtureScraper(html));
  }

  beforeEach(async () => {
    setTestEnvironment(
      createTestConfig({ databasePath: ':memory:', authorizedGroupId: 'test-group@g.us' })
    );

    closeDatabase();
    const { db } = getDatabase();
    const migrationsFolder = resolve(__dirname, '../../../drizzle');
    migrate(db, { migrationsFolder });

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();

    gateway = new FakeGateway();

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

  describe('--dry-run', () => {
    it('re-fetches + previews the next fixture, sends nothing, exit 0', async () => {
      await pollCommand({ dryRun: true }, { gateway, fixtureService: fixtureServiceWith() });

      expect(exitCode).toBe(0);
      expect(gateway.sentPolls).toHaveLength(0);

      // The previewed fixture is the next upcoming one the re-fetch persisted.
      const { db } = getDatabase();
      const [season] = await db.select().from(schema.seasons);
      const upcoming = await new FixtureService(
        db,
        new SeasonService(db),
        new MockFixtureScraper()
      ).getUpcomingFixtures(season!.id);
      expect(upcoming.length).toBeGreaterThan(0);
      expect(consoleOutput.join('\n')).toContain(upcoming[0]!.opponent);
    });

    it('stores no poll row during dry run', async () => {
      await pollCommand({ dryRun: true }, { gateway, fixtureService: fixtureServiceWith() });

      const { db } = getDatabase();
      const polls = await db.select().from(schema.polls);
      expect(polls).toHaveLength(0);
    });
  });

  describe('exit codes', () => {
    it('exits 3 when AUTHORIZED_GROUP_ID is unset', async () => {
      setTestEnvironment(
        createTestConfig({ databasePath: ':memory:', authorizedGroupId: undefined })
      );

      await pollCommand({}, { gateway, fixtureService: fixtureServiceWith() });
      expect(exitCode).toBe(3);
      expect(gateway.sentPolls).toHaveLength(0);
    });

    it('exits 1 when re-fetch yields no confirmed next fixture (FR-028)', async () => {
      await pollCommand(
        {},
        { gateway, fixtureService: fixtureServiceWith(PLACEHOLDER_ONLY_HTML) }
      );

      expect(exitCode).toBe(1);
      expect(gateway.sentPolls).toHaveLength(0);
    });

    it('exits 0 and posts a poll on the happy path', async () => {
      await pollCommand({}, { gateway, fixtureService: fixtureServiceWith() });

      expect(exitCode).toBe(0);
      expect(gateway.sentPolls).toHaveLength(1);
    });

    it('exits 2 when a poll already exists and --force is not set', async () => {
      const fixtureService = fixtureServiceWith();
      await pollCommand({}, { gateway, fixtureService });
      exitCode = null;

      await pollCommand({}, { gateway, fixtureService });

      expect(exitCode).toBe(2);
      expect(gateway.sentPolls).toHaveLength(1);
    });
  });

  describe('--force replacement (FR-027)', () => {
    it('re-posts and leaves exactly one poll row', async () => {
      const fixtureService = fixtureServiceWith();
      await pollCommand({}, { gateway, fixtureService });
      exitCode = null;

      await pollCommand({ force: true }, { gateway, fixtureService });

      expect(exitCode).toBe(0);
      expect(gateway.sentPolls).toHaveLength(2);

      const { db } = getDatabase();
      const polls = await db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
    });
  });
});
