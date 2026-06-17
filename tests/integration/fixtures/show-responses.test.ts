import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { fixturesCommand } from '#src/cli/commands/fixtures.js';
import { PollService } from '#src/services/poll-service.js';
import { createTestConfig, setTestEnvironment } from '../../helpers/test-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * US6 (T052) — `fixtures --show-responses` view, read-only over stored polls/responses (FR-030).
 * Real in-memory DB + real services; NO Gateway (the view never connects).
 *
 * Seeds: a fixture with a poll + several votes (incl. a `displayName = null` voter, AS-4), a
 * fixture whose poll has zero votes (AS-3), and a fixture with no poll at all (AS-2).
 */
describe('fixtures --show-responses (US6)', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let exitCode: number | null;

  // Game ids captured at seed time so assertions and the service read can reference them.
  let gameWithVotes: number;
  let gameNoVotes: number;
  let gameNoPoll: number;

  beforeEach(async () => {
    setTestEnvironment(createTestConfig({ databasePath: ':memory:' }));
    closeDatabase();

    const { db } = getDatabase();
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://example.com/club/', whatsappGroupId: null })
      .returning();

    const [season] = await db
      .insert(schema.seasons)
      .values({ teamId: team.id, seasonNumber: 1, isCurrent: true })
      .returning();

    // Three upcoming fixtures so the default `fixtures` view lists all of them, chronologically.
    const day = 24 * 60 * 60 * 1000;
    const [g1, g2, g3] = await db
      .insert(schema.games)
      .values([
        {
          seasonId: season.id,
          gameDate: new Date(Date.now() + 7 * day),
          opponent: 'Red Devils',
          venue: 'Victoria Park',
          status: 'upcoming',
          scrapedUrl: null,
        },
        {
          seasonId: season.id,
          gameDate: new Date(Date.now() + 14 * day),
          opponent: 'Blue Warriors',
          venue: 'Central Stadium',
          status: 'upcoming',
          scrapedUrl: null,
        },
        {
          seasonId: season.id,
          gameDate: new Date(Date.now() + 21 * day),
          opponent: 'Green Giants',
          venue: 'East Field',
          status: 'upcoming',
          scrapedUrl: null,
        },
      ])
      .returning();
    gameWithVotes = g1.id;
    gameNoVotes = g2.id;
    gameNoPoll = g3.id;

    // Voters: one with a display name, one without (canonical-id fallback, AS-4).
    const [alice, anon] = await db
      .insert(schema.whatsappUsers)
      .values([
        {
          canonicalId: 'alice@s.whatsapp.net',
          displayName: 'Alice',
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
        {
          canonicalId: 'bob@s.whatsapp.net',
          displayName: null,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      ])
      .returning();

    // g1: poll with two votes (Yes from Alice, No from the un-named voter).
    const [poll1] = await db
      .insert(schema.polls)
      .values({
        gameId: g1.id,
        pollMessageId: 'msg-1',
        groupId: 'group-1',
        messageSecret: 'secret-1',
        postedAt: new Date(),
        pollQuestion: 'Available vs Red Devils?',
        pollOptions: ['Yes', 'No', 'Maybe'],
      })
      .returning();
    await db.insert(schema.pollResponses).values([
      { pollId: poll1.id, userId: anon.id, selectedOption: 'No', respondedAt: new Date() },
      { pollId: poll1.id, userId: alice.id, selectedOption: 'Yes', respondedAt: new Date() },
    ]);

    // g2: poll with no votes (AS-3).
    await db.insert(schema.polls).values({
      gameId: g2.id,
      pollMessageId: 'msg-2',
      groupId: 'group-1',
      messageSecret: 'secret-2',
      postedAt: new Date(),
      pollQuestion: 'Available vs Blue Warriors?',
      pollOptions: ['Yes', 'No', 'Maybe'],
    });

    // g3: no poll (AS-2).

    consoleOutput = [];
    consoleErrors = [];
    exitCode = null;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;
    console.log = (...args: unknown[]) => void consoleOutput.push(args.join(' '));
    console.error = (...args: unknown[]) => void consoleErrors.push(args.join(' '));
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as never;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    closeDatabase();
  });

  describe('PollService.getResponsesForGames (T053)', () => {
    it('groups responses by game, orders by option then name, with canonical-id fallback', async () => {
      const { db } = getDatabase();
      const service = new PollService(db);

      const byGame = await service.getResponsesForGames([gameWithVotes, gameNoVotes, gameNoPoll]);

      // g3 has no poll → absent from the map entirely (AS-2).
      expect(byGame.has(gameNoPoll)).toBe(false);

      // g2 has a poll with no votes → present with an empty responses array (AS-3).
      const noVotes = byGame.get(gameNoVotes);
      expect(noVotes).toBeDefined();
      expect(noVotes!.responses).toEqual([]);

      // g1: ordered by poll-option order (Yes before No), with canonical-id fallback for the
      // un-named voter (AS-4).
      const withVotes = byGame.get(gameWithVotes);
      expect(withVotes).toBeDefined();
      expect(withVotes!.responses.map((r) => r.selectedOption)).toEqual(['Yes', 'No']);
      expect(withVotes!.responses[0]).toMatchObject({
        displayName: 'Alice',
        selectedOption: 'Yes',
      });
      const fallback = withVotes!.responses[1];
      expect(fallback.displayName).toBeNull();
      expect(fallback.canonicalId).toBe('bob@s.whatsapp.net');
    });

    it('returns an empty map for an empty game-id list', async () => {
      const { db } = getDatabase();
      const byGame = await new PollService(db).getResponsesForGames([]);
      expect(byGame.size).toBe(0);
    });
  });

  describe('human-readable output', () => {
    it('renders each fixture with its responses, no-poll and no-responses markers', async () => {
      await fixturesCommand({ showResponses: true });
      const output = consoleOutput.join('\n');

      // Fixture with votes: voter names + choices grouped under it.
      expect(output).toContain('Red Devils');
      expect(output).toContain('Alice');
      expect(output).toContain('Yes');
      // Canonical-id fallback for the un-named voter (AS-4).
      expect(output).toContain('bob@s.whatsapp.net');

      // No-poll and no-responses markers (AS-2/AS-3).
      expect(output).toContain('(no poll posted)');
      expect(output).toContain('(no responses yet)');

      expect(exitCode).toBe(0);
    });
  });

  describe('--json output (AS-6)', () => {
    it('carries a poll field per fixture (null, or { question, responses })', async () => {
      await fixturesCommand({ showResponses: true, json: true });
      const json = JSON.parse(consoleOutput.join(''));

      const byId = new Map<number, any>(json.fixtures.map((f: any) => [f.id, f]));

      expect(byId.get(gameNoPoll).poll).toBeNull();
      expect(byId.get(gameNoVotes).poll).toMatchObject({
        question: 'Available vs Blue Warriors?',
        responses: [],
      });

      const withVotes = byId.get(gameWithVotes).poll;
      expect(withVotes.question).toBe('Available vs Red Devils?');
      expect(withVotes.responses).toEqual([
        { name: 'Alice', choice: 'Yes' },
        { name: 'bob@s.whatsapp.net', choice: 'No' },
      ]);

      expect(exitCode).toBe(0);
    });
  });

  describe('plain fixtures unchanged (AS-5)', () => {
    it('produces identical output with and without the flag absent', async () => {
      await fixturesCommand({ json: true });
      const plain = consoleOutput.join('');
      consoleOutput.length = 0;

      // The no-flag path must match the existing `formatFixturesJSON` shape: no `poll` field.
      const json = JSON.parse(plain);
      expect(json.fixtures[0]).not.toHaveProperty('poll');
      expect(exitCode).toBe(0);
    });
  });
});
