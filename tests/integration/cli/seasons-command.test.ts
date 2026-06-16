import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { seasonsCommand } from '#src/cli/commands/seasons.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * CLI `seasons` command (T039, US4 — FR-004). Lists season history (number, date range, current
 * flag) so a previous season can be selected for `fixtures`/`stats`.
 */
describe('CLI seasons command (US4)', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let exitCode: number | null;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ databasePath: ':memory:' }));
    closeDatabase();

    const { db } = getDatabase();
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    await db.insert(schema.seasons).values([
      { teamId: team!.id, seasonNumber: 1, isCurrent: false },
      { teamId: team!.id, seasonNumber: 2, isCurrent: true },
    ]);

    consoleOutput = [];
    exitCode = null;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;
    console.log = (...args: any[]) => void consoleOutput.push(args.join(' '));
    console.error = () => {};
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as any;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    closeDatabase();
  });

  it('lists all seasons (human-readable)', async () => {
    await seasonsCommand({});
    const output = consoleOutput.join('\n');
    expect(output).toContain('Season 1');
    expect(output).toContain('Season 2');
    expect(exitCode).toBe(0);
  });

  it('outputs season list as JSON with --json (number, range, current flag)', async () => {
    await seasonsCommand({ json: true });
    const json = JSON.parse(consoleOutput.join(''));
    expect(Array.isArray(json.seasons)).toBe(true);
    expect(json.seasons).toHaveLength(2);
    const current = json.seasons.find((s: any) => s.current === true);
    expect(current.season).toBe(2);
    expect(json.seasons[0]).toHaveProperty('start');
    expect(json.seasons[0]).toHaveProperty('end');
    expect(exitCode).toBe(0);
  });
});
