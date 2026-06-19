import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as schema from '#src/database/schema.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { FakeGateway, TEST_GROUP_ID } from '../../helpers/fake-gateway.js';
import { AggregateService } from '#src/services/aggregate-service.js';
import { getPollOptions } from '#src/whatsapp/poll-presenter.js';
import { formatReportBlock } from '#src/cli/output/aggregate-formatters.js';
import {
  isStatsCommand,
  createStatsHandler,
  STATS_MIN_INTERVAL_MS,
  NO_DATA_REPLY,
} from '#src/whatsapp/stats-trigger.js';

/**
 * `!stats` in-chat trigger driven through FakeGateway.simulateMessage. Mirrors
 * postpoll-trigger.test.ts: the handler is wired to onMessage exactly as the event-router wires it
 * (`isStatsCommand` gates first). Real in-memory DB + AggregateService; the posted report IS the
 * response.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const YES = getPollOptions()[0]!;

describe('isStatsCommand', () => {
  it('matches the whole message "!stats" case-insensitively and trimmed', () => {
    expect(isStatsCommand('!stats')).toBe(true);
    expect(isStatsCommand('  !Stats  ')).toBe(true);
    expect(isStatsCommand('!STATS')).toBe(true);
  });

  it('ignores ordinary chat that merely contains the word (FR-019)', () => {
    expect(isStatsCommand('stats')).toBe(false);
    expect(isStatsCommand('!stats now')).toBe(false);
    expect(isStatsCommand("let's check stats")).toBe(false);
    expect(isStatsCommand('!statsx')).toBe(false);
    expect(isStatsCommand(null)).toBe(false);
    expect(isStatsCommand('')).toBe(false);
  });
});

describe('handleStats trigger', () => {
  let testDb: TestDatabase;
  let gateway: FakeGateway;
  let seasonId: number;

  /** Insert team + a current season; returns the season id. */
  async function seedCurrentSeason(): Promise<number> {
    const { db } = testDb;
    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    const [season] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();
    return season!.id;
  }

  /** Seed a completed game with a poll, two Yes voters, and their stat lines — report has data. */
  async function seedReportData(seasonIdToSeed: number): Promise<void> {
    const { db } = testDb;
    const [alice] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'alice@id', displayName: 'Alice' })
      .returning();
    const [bob] = await db
      .insert(schema.whatsappUsers)
      .values({ canonicalId: 'bob@id', displayName: 'Bob' })
      .returning();
    const [g1] = await db
      .insert(schema.games)
      .values({
        seasonId: seasonIdToSeed,
        gameDate: new Date(Date.now() - 7 * DAY_MS),
        opponent: 'Red Devils',
        venue: 'Home',
        status: 'completed',
      })
      .returning();
    const [p1] = await db
      .insert(schema.polls)
      .values({
        gameId: g1!.id,
        pollMessageId: 'poll-1',
        groupId: TEST_GROUP_ID,
        messageSecret: 'c2VjcmV0',
        postedAt: new Date(Date.now() - 8 * DAY_MS),
        pollQuestion: 'Poll 1',
        pollOptions: getPollOptions(),
      })
      .returning();
    await db.insert(schema.pollResponses).values([
      { pollId: p1!.id, userId: alice!.id, selectedOption: YES, respondedAt: new Date() },
      { pollId: p1!.id, userId: bob!.id, selectedOption: YES, respondedAt: new Date() },
    ]);
    await db.insert(schema.statRecords).values([
      {
        gameId: g1!.id,
        userId: alice!.id,
        goals: 2,
        assists: 1,
        weightDirection: 'down',
        foodTracking: true,
        confidenceScore: 95,
      },
      {
        gameId: g1!.id,
        userId: bob!.id,
        goals: 1,
        assists: 0,
        weightDirection: 'up',
        foodTracking: false,
        confidenceScore: 90,
      },
    ]);
  }

  /** Wire an AggregateService + the trigger handler over the gateway, exactly as the router will. */
  function wireHandler(
    opts: { minIntervalMs?: number; now?: () => number } = {}
  ): AggregateService {
    const { db } = testDb;
    const aggregateService = new AggregateService(db);
    const handleStats = createStatsHandler({
      aggregateService,
      gateway,
      groupId: TEST_GROUP_ID,
      minIntervalMs: opts.minIntervalMs ?? 0,
      now: opts.now,
    });
    gateway.onMessage((m) => {
      if (isStatsCommand(m.text)) return handleStats(m);
    });
    return aggregateService;
  }

  beforeEach(async () => {
    testDb = createTestDatabase();
    gateway = new FakeGateway();
    seasonId = await seedCurrentSeason();
  });

  afterEach(() => {
    testDb.close();
  });

  it('(a) posts exactly the current season report block to the group (FR-020)', async () => {
    await seedReportData(seasonId);
    const service = wireHandler();

    await gateway.simulateMessage({ text: '!stats' });

    expect(gateway.sentMessages).toHaveLength(1);
    expect(gateway.sentMessages[0]!.groupId).toBe(TEST_GROUP_ID);
    expect(gateway.sentMessages[0]!.text).toBe(
      formatReportBlock(await service.getReport(seasonId))
    );
  });

  it('(b) a current season with no data posts the "no data" message, not an empty block (FR-020/FR-011)', async () => {
    wireHandler();

    await gateway.simulateMessage({ text: '!stats' });

    expect(gateway.sentMessages).toHaveLength(1);
    expect(gateway.sentMessages[0]!.text).toBe(NO_DATA_REPLY);
  });

  it('(c) ordinary chat containing "stats" sends nothing', async () => {
    await seedReportData(seasonId);
    wireHandler();

    await gateway.simulateMessage({ text: 'how were the stats' });

    expect(gateway.sentMessages).toHaveLength(0);
  });

  it('(d) throttles a second !stats inside the window, then posts again after it elapses (FR-021)', async () => {
    await seedReportData(seasonId);
    let nowMs = 1_000_000;
    wireHandler({ minIntervalMs: STATS_MIN_INTERVAL_MS, now: () => nowMs });

    await gateway.simulateMessage({ text: '!stats' });
    expect(gateway.sentMessages).toHaveLength(1);

    // Second trigger inside the window — silent, no post.
    await gateway.simulateMessage({ text: '!stats' });
    expect(gateway.sentMessages).toHaveLength(1);

    // Advance past the window — a fresh report is posted.
    nowMs += STATS_MIN_INTERVAL_MS + 1;
    await gateway.simulateMessage({ text: '!stats' });
    expect(gateway.sentMessages).toHaveLength(2);
  });

  it('(e) a compute/post failure is swallowed — no throw, nothing partial sent (FR-022)', async () => {
    await seedReportData(seasonId);
    wireHandler();
    gateway.sendMessage = async () => {
      throw new Error('Simulated send failure');
    };

    await expect(gateway.simulateMessage({ text: '!stats' })).resolves.toBeUndefined();
    expect(gateway.sentMessages).toHaveLength(0);
  });
});
