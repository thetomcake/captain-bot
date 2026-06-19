import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '#src/database/schema.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { FakeGateway, TEST_GROUP_ID, IDENTITIES } from '../../helpers/fake-gateway.js';
import { StatService } from '#src/services/stat-service.js';
import { registerEventRouter } from '#src/whatsapp/event-router.js';
import { PollService } from '#src/services/poll-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';

/**
 * Stat capture from chat (T032, US3 — FR-015/FR-017/FR-019/FR-020/FR-024) driven through
 * FakeGateway.simulateMessage and the real event-router (T035): `!postpoll` is intercepted before
 * stat parsing, ordinary messages go to capture. Real in-memory DB; identity-keyed attribution.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

describe('stat capture via event-router', () => {
  let testDb: TestDatabase;
  let gateway: FakeGateway;
  let statService: StatService;
  let seasonId: number;
  let postPollCalls: number;

  /** Insert a game `daysAgo` days before now (its 3-day window may or may not still be open). */
  async function insertGame(daysAgo: number, opponent = 'Red Devils'): Promise<number> {
    const [game] = await testDb.db
      .insert(schema.games)
      .values({
        seasonId,
        gameDate: new Date(Date.now() - daysAgo * DAY_MS),
        opponent,
        venue: 'Home',
        status: 'completed',
      })
      .returning();
    return game!.id;
  }

  /** Read the single stat row for (gameId, alice), or null. */
  async function aliceStat(gameId: number) {
    const [user] = await testDb.db
      .select()
      .from(schema.whatsappUsers)
      .where(eq(schema.whatsappUsers.canonicalId, IDENTITIES.alice.canonicalId))
      .limit(1);
    if (!user) return null;
    const [row] = await testDb.db
      .select()
      .from(schema.statRecords)
      .where(and(eq(schema.statRecords.gameId, gameId), eq(schema.statRecords.userId, user.id)))
      .limit(1);
    return row ?? null;
  }

  beforeEach(async () => {
    testDb = createTestDatabase();
    const { db } = testDb;
    gateway = new FakeGateway();

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    const [season] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();
    seasonId = season!.id;

    statService = new StatService(db);
    const fixtureService = new FixtureService(db, new SeasonService(db), new MockFixtureScraper());
    const pollService = new PollService(db, fixtureService, gateway, TEST_GROUP_ID);

    // Wire the real router; stub the !postpoll handler so we can assert routing-first.
    postPollCalls = 0;
    registerEventRouter({
      gateway,
      statService,
      pollService,
      handlePostPoll: async () => {
        postPollCalls += 1;
      },
      handleStats: async () => {},
    });
  });

  afterEach(() => {
    testDb.close();
  });

  it('captures stats within the 3-day window, attributed to the sender canonical identity', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({
      sender: IDENTITIES.alice,
      text: '2 goals, 1 assist, weight down, tracked food',
    });

    const row = await aliceStat(gameId);
    expect(row).not.toBeNull();
    expect(row!.goals).toBe(2);
    expect(row!.assists).toBe(1);
    expect(row!.weightDirection).toBe('down');
    expect(row!.foodTracking).toBe(true);
  });

  it('treats a message 4+ days after the game as ordinary chat (no capture, FR-017)', async () => {
    const gameId = await insertGame(4);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: '2 goals, 1 assist' });

    expect(await aliceStat(gameId)).toBeNull();
  });

  it('applies defaults on the first capture (goals=0/assists=0/weight=unknown/tracking=no, FR-020)', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: 'scored today' });

    const row = await aliceStat(gameId);
    expect(row!.goals).toBe(1);
    expect(row!.assists).toBe(0);
    expect(row!.weightDirection).toBe('unknown');
    expect(row!.foodTracking).toBe(false);
  });

  it('merges only the fields mentioned in a later partial message (FR-019)', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: '2 goals' });
    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: '1 assist' });

    const row = await aliceStat(gameId);
    expect(row!.goals).toBe(2); // untouched by the second message
    expect(row!.assists).toBe(1); // merged in
  });

  it('an explicit correction overrides only the named field (FR-019)', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: '2 goals, 2 assists' });
    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: 'correction 1 goal' });

    const row = await aliceStat(gameId);
    expect(row!.goals).toBe(1); // corrected
    expect(row!.assists).toBe(2); // left unchanged
  });

  it('does not capture casual chat below the confidence threshold (FR-018)', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: 'great game everyone' });

    expect(await aliceStat(gameId)).toBeNull();
  });

  it('routes !postpoll to the poll handler and never captures it as a stat (FR-029)', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: '!postpoll' });

    expect(postPollCalls).toBe(1);
    expect(await aliceStat(gameId)).toBeNull();
  });

  it('collapses two address forms of one person to a single stat row (SC-008)', async () => {
    const gameId = await insertGame(1);

    await gateway.simulateMessage({ sender: IDENTITIES.alice, text: '2 goals' });
    await gateway.simulateMessage({ sender: IDENTITIES.aliceLid, text: '1 assist' });

    const rows = await testDb.db
      .select()
      .from(schema.statRecords)
      .where(eq(schema.statRecords.gameId, gameId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.goals).toBe(2);
    expect(rows[0]!.assists).toBe(1);
  });
});
