import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { endOfSeasonCommand } from '#src/cli/commands/end-of-season.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * CLI `end-of-season` command (T015, US4 — FR-010/FR-013, contract cli-end-of-season.md). Manual
 * season rollover: confirm by default, `--yes`/`--force` to skip; no-current-season is a safe no-op.
 * The confirmation prompt is injected (`deps.confirm`) so the command is testable without a TTY.
 */
describe('CLI end-of-season command (US4)', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let exitCode: number | null;
  let teamId: number;

  async function seedCurrentSeason(): Promise<void> {
    const { db } = getDatabase();
    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    teamId = team!.id;
    await db
      .insert(schema.seasons)
      .values({ teamId, seasonNumber: 3, isCurrent: true })
      .returning();
  }

  beforeEach(() => {
    setTestEnvironment(createTestConfig({ databasePath: ':memory:' }));
    closeDatabase();

    const { db } = getDatabase();
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    consoleOutput = [];
    exitCode = null;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;
    console.log = (...args: any[]) => void consoleOutput.push(args.join(' '));
    console.error = (...args: any[]) => void consoleOutput.push(args.join(' '));
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as any;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    vi.restoreAllMocks();
    closeDatabase();
  });

  async function currentSeason() {
    const { db } = getDatabase();
    const [season] = await db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.teamId, teamId))
      .limit(1);
    return season!;
  }

  it('ends the current season when the user confirms (AS3)', async () => {
    await seedCurrentSeason();

    await endOfSeasonCommand({}, { confirm: async () => true });

    const season = await currentSeason();
    expect(season.isCurrent).toBe(false);
    expect(season.endDate).toBeInstanceOf(Date);
    expect(exitCode).toBe(0);
    expect(consoleOutput.join('\n')).toMatch(/Season 3 ended/);
  });

  it('makes no changes and exits 0 when the user declines (AS3)', async () => {
    await seedCurrentSeason();

    await endOfSeasonCommand({}, { confirm: async () => false });

    const season = await currentSeason();
    expect(season.isCurrent).toBe(true);
    expect(season.endDate).toBeNull();
    expect(exitCode).toBe(0);
    expect(consoleOutput.join('\n')).toMatch(/[Cc]ancel/);
  });

  it('skips the prompt entirely with --yes (AS4)', async () => {
    await seedCurrentSeason();
    const confirm = vi.fn(async () => true);

    await endOfSeasonCommand({ yes: true }, { confirm });

    expect(confirm).not.toHaveBeenCalled();
    const season = await currentSeason();
    expect(season.isCurrent).toBe(false);
    expect(exitCode).toBe(0);
  });

  it('skips the prompt entirely with --force (AS4)', async () => {
    await seedCurrentSeason();
    const confirm = vi.fn(async () => true);

    await endOfSeasonCommand({ force: true }, { confirm });

    expect(confirm).not.toHaveBeenCalled();
    const season = await currentSeason();
    expect(season.isCurrent).toBe(false);
    expect(exitCode).toBe(0);
  });

  it('reports "no active season to end", makes no changes, exits 0 when there is none (AS5)', async () => {
    // No team / season seeded — getCurrentSeason returns null.
    const confirm = vi.fn(async () => true);

    await endOfSeasonCommand({}, { confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(consoleOutput.join('\n')).toMatch(/no active season/i);
  });

  it('emits the contract JSON shape when ending a season (--json)', async () => {
    await seedCurrentSeason();

    await endOfSeasonCommand({ json: true }, { confirm: async () => true });

    const json = JSON.parse(consoleOutput.join(''));
    expect(json).toMatchObject({ ended: true, seasonNumber: 3 });
    expect(typeof json.endDate).toBe('string');
    expect(exitCode).toBe(0);
  });

  it('emits the no-current-season JSON shape (--json, AS5)', async () => {
    await endOfSeasonCommand({ json: true }, { confirm: async () => true });

    const json = JSON.parse(consoleOutput.join(''));
    expect(json).toMatchObject({ ended: false, reason: 'no-current-season' });
    expect(exitCode).toBe(0);
  });

  it('emits the cancelled JSON shape when declined (--json)', async () => {
    await seedCurrentSeason();

    await endOfSeasonCommand({ json: true }, { confirm: async () => false });

    const json = JSON.parse(consoleOutput.join(''));
    expect(json).toMatchObject({ ended: false, reason: 'cancelled' });
    expect(exitCode).toBe(0);
  });
});
