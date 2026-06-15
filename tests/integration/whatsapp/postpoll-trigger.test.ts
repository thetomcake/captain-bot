import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as schema from '#src/database/schema.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { FakeGateway, TEST_GROUP_ID } from '../../helpers/fake-gateway.js';
import { PollService } from '#src/services/poll-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { MockFixtureScraper, ErrorMockScraper } from '../../helpers/mock-scraper.js';
import {
  isPostPollCommand,
  createPostPollHandler,
  POSTPOLL_MIN_INTERVAL_MS,
} from '#src/whatsapp/postpoll-trigger.js';

/**
 * `!postpoll` in-chat trigger (T049/T050) driven through FakeGateway.simulateMessage.
 *
 * Fixtures come ONLY from static HTML via MockFixtureScraper (`manvfat-fixtures.html`) or a
 * placeholder-only snippet / ErrorMockScraper — never a real fetch. The handler is wired to
 * onMessage exactly as the event-router (T035) will wire it: `isPostPollCommand` gates first.
 */
const PLACEHOLDER_ONLY_HTML = `
<div class="week"><div class="inner">
  <div class="group-header white">Week 7 - June 29th</div>
  <table class="fixture-table">
    <tr class="no-highlight"><td colspan="6" class="subtitle">Fixtures to be confirmed</td></tr>
  </table>
</div></div>`;

describe('isPostPollCommand', () => {
  it('matches the whole message "!postpoll" case-insensitively and trimmed', () => {
    expect(isPostPollCommand('!postpoll')).toBe(true);
    expect(isPostPollCommand('  !PostPoll  ')).toBe(true);
    expect(isPostPollCommand('!POSTPOLL')).toBe(true);
  });

  it('ignores ordinary chat that merely contains the words (FR-029)', () => {
    expect(isPostPollCommand('can someone post poll please')).toBe(false);
    expect(isPostPollCommand('!postpoll now')).toBe(false);
    expect(isPostPollCommand('postpoll')).toBe(false);
    expect(isPostPollCommand(null)).toBe(false);
    expect(isPostPollCommand('')).toBe(false);
  });
});

describe('handlePostPoll trigger', () => {
  let testDb: TestDatabase;
  let gateway: FakeGateway;

  /**
   * Wire a PollService + trigger handler over a scraper, exactly as the event-router will.
   * `minIntervalMs` defaults to `0` so post/replace behaviour is exercised without the throttle;
   * the throttle itself is covered by its own describe block with the real window.
   */
  function wireHandler(
    scraper: MockFixtureScraper | ErrorMockScraper,
    minIntervalMs = 0
  ): PollService {
    const { db } = testDb;
    const fixtureService = new FixtureService(db, new SeasonService(db), scraper);
    const pollService = new PollService(db, fixtureService, gateway, TEST_GROUP_ID);
    const handlePostPoll = createPostPollHandler({
      pollService,
      gateway,
      groupId: TEST_GROUP_ID,
      minIntervalMs,
    });
    gateway.onMessage((m) => {
      if (isPostPollCommand(m.text)) return handlePostPoll(m);
    });
    return pollService;
  }

  beforeEach(async () => {
    testDb = createTestDatabase();
    const { db } = testDb;
    gateway = new FakeGateway();

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();
  });

  afterEach(() => {
    testDb.close();
  });

  it('(a) posts a poll for the next fixture, silent in chat on success', async () => {
    wireHandler(new MockFixtureScraper());

    await gateway.simulateMessage({ text: '!postpoll' });

    expect(gateway.sentPolls).toHaveLength(1);
    expect(gateway.sentMessages).toHaveLength(0); // silent on success
    const polls = await testDb.db.select().from(schema.polls);
    expect(polls).toHaveLength(1);
  });

  it('(b) a second !postpoll replaces the prior poll + responses with a fresh one', async () => {
    wireHandler(new MockFixtureScraper());

    await gateway.simulateMessage({ text: '!postpoll' });
    await gateway.simulateMessage({ text: '!postpoll' });

    expect(gateway.sentPolls).toHaveLength(2);
    const polls = await testDb.db.select().from(schema.polls);
    expect(polls).toHaveLength(1);
    expect(gateway.deletedMessages).toHaveLength(1);
  });

  it('(c) no confirmed next fixture → no poll, in-chat reply', async () => {
    wireHandler(new MockFixtureScraper(PLACEHOLDER_ONLY_HTML));

    await gateway.simulateMessage({ text: '!postpoll' });

    expect(gateway.sentPolls).toHaveLength(0);
    expect(gateway.sentMessages).toHaveLength(1);
    expect(gateway.sentMessages[0]!.groupId).toBe(TEST_GROUP_ID);
  });

  it('(d) scrape failure → no poll, in-chat error reply (FR-028)', async () => {
    wireHandler(new ErrorMockScraper('club site down'));

    await gateway.simulateMessage({ text: '!postpoll' });

    expect(gateway.sentPolls).toHaveLength(0);
    expect(gateway.sentMessages).toHaveLength(1);
  });

  it('(e) ordinary chat containing "post poll" is ignored (FR-029)', async () => {
    wireHandler(new MockFixtureScraper());

    await gateway.simulateMessage({ text: 'we should post poll soon' });

    expect(gateway.sentPolls).toHaveLength(0);
    expect(gateway.sentMessages).toHaveLength(0);
  });
});

describe('handlePostPoll throttle (T051)', () => {
  let testDb: TestDatabase;
  let gateway: FakeGateway;

  beforeEach(async () => {
    testDb = createTestDatabase();
    const { db } = testDb;
    gateway = new FakeGateway();

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();

    // Wire with the REAL throttle window this time.
    const fixtureService = new FixtureService(db, new SeasonService(db), new MockFixtureScraper());
    const pollService = new PollService(db, fixtureService, gateway, TEST_GROUP_ID);
    const handlePostPoll = createPostPollHandler({
      pollService,
      gateway,
      groupId: TEST_GROUP_ID,
      minIntervalMs: POSTPOLL_MIN_INTERVAL_MS,
    });
    gateway.onMessage((m) => {
      if (isPostPollCommand(m.text)) return handlePostPoll(m);
    });
  });

  afterEach(() => {
    testDb.close();
  });

  it('ignores a second !postpoll inside the 5-minute window (no post, silent)', async () => {
    await gateway.simulateMessage({ text: '!postpoll' });
    await gateway.simulateMessage({ text: '!postpoll' });

    expect(gateway.sentPolls).toHaveLength(1); // second trigger ignored
    expect(gateway.sentMessages).toHaveLength(0); // silent — no in-chat reply
    const polls = await testDb.db.select().from(schema.polls);
    expect(polls).toHaveLength(1);
  });

  it('allows a !postpoll once the window has elapsed (replaces the poll)', async () => {
    await gateway.simulateMessage({ text: '!postpoll' });
    expect(gateway.sentPolls).toHaveLength(1);

    // Backdate the recorded post time to just beyond the throttle window.
    await testDb.db
      .update(schema.teams)
      .set({ lastPollPostedAt: new Date(Date.now() - POSTPOLL_MIN_INTERVAL_MS - 1000) });

    await gateway.simulateMessage({ text: '!postpoll' });

    expect(gateway.sentPolls).toHaveLength(2); // window elapsed → replacement posted
    const polls = await testDb.db.select().from(schema.polls);
    expect(polls).toHaveLength(1);
  });
});
