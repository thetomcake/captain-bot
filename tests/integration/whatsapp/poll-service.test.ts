import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '#src/database/schema.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { FakeGateway, IDENTITIES, TEST_GROUP_ID } from '../../helpers/fake-gateway.js';
import { PollService } from '#src/services/poll-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';
import type { PollVote } from '#src/whatsapp/gateway-port.js';
import { logger } from '#src/utils/logger.js';

/**
 * PollService reworked onto the Gateway port (T024/T028/T029).
 *
 * Fixtures come ONLY from the static `manvfat-fixtures.html` via MockFixtureScraper — no real
 * network fetch ever happens. The FakeGateway records sent polls (with keysets) and deletes.
 */
describe('PollService (Gateway-native)', () => {
  let testDb: TestDatabase;
  let gateway: FakeGateway;
  let pollService: PollService;
  let fixtureService: FixtureService;
  let teamId: number;

  /** Build a PollVote delta for the most-recently-posted poll. */
  function voteFor(voter: PollVote['voter'], selectedOptions: string[]): PollVote {
    const sent = gateway.sentPolls[gateway.sentPolls.length - 1]!;
    return {
      pollId: sent.keyset.pollId,
      groupId: sent.keyset.groupId,
      voter,
      selectedOptions,
      timestamp: new Date(),
    };
  }

  beforeEach(async () => {
    testDb = createTestDatabase();
    const { db } = testDb;

    gateway = new FakeGateway();
    const seasonService = new SeasonService(db);
    fixtureService = new FixtureService(db, seasonService, new MockFixtureScraper());
    pollService = new PollService(db, fixtureService, gateway, TEST_GROUP_ID);

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    teamId = team!.id;

    await db
      .insert(schema.seasons)
      .values({ teamId, seasonNumber: 1, isCurrent: true })
      .returning();

    // Route the gateway's poll-vote events into the service tally.
    gateway.onPollVote((v) => pollService.handlePollVote(v));
  });

  afterEach(() => {
    testDb.close();
  });

  describe('postOrReplaceNextPoll — keyset persistence', () => {
    it('persists the keyset (messageSecret + groupId + pollMessageId + exact options) onto the poll row', async () => {
      const result = await pollService.postOrReplaceNextPoll();
      expect(result.outcome).toBe('posted');
      expect(gateway.sentPolls).toHaveLength(1);

      const sent = gateway.sentPolls[0]!;
      const [poll] = await testDb.db.select().from(schema.polls);
      expect(poll).toBeDefined();
      expect(poll!.pollMessageId).toBe(sent.keyset.pollId);
      expect(poll!.groupId).toBe(TEST_GROUP_ID);
      expect(poll!.messageSecret).toBe(sent.keyset.messageSecret);
      expect(poll!.pollOptions).toEqual(['Yes', 'No', 'Maybe']);
    });

    it('returns no-fixture when no team is configured', async () => {
      await testDb.db.delete(schema.seasons);
      await testDb.db.delete(schema.teams);
      const result = await pollService.postOrReplaceNextPoll();
      expect(result.outcome).toBe('no-fixture');
      expect(gateway.sentPolls).toHaveLength(0);
    });
  });

  describe('handlePollVote — durable per-voter tally (FR-013/SC-008)', () => {
    beforeEach(async () => {
      await pollService.postOrReplaceNextPoll();
    });

    it('records a vote against the voter canonical identity', async () => {
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['Yes']));

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.selectedOption).toBe('Yes');

      const users = await testDb.db.select().from(schema.whatsappUsers);
      expect(users).toHaveLength(1);
      expect(users[0]!.canonicalId).toBe(IDENTITIES.alice.canonicalId);
    });

    it('overwrites a changed vote (one row per voter)', async () => {
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['Yes']));
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['No']));

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.selectedOption).toBe('No');
    });

    it('deletes the row on withdrawal (empty selection)', async () => {
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['Yes']));
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, []));

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(0);
    });

    it('collapses two address forms of the same person to one row (SC-008)', async () => {
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['Yes']));
      await gateway.simulatePollVote(voteFor(IDENTITIES.aliceLid, ['No']));

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.selectedOption).toBe('No');

      const users = await testDb.db.select().from(schema.whatsappUsers);
      expect(users).toHaveLength(1);
    });

    it('keeps distinct voters as distinct rows', async () => {
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['No']));
      await gateway.simulatePollVote(voteFor(IDENTITIES.bob, ['Yes']));

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(2);
    });

    it('ignores votes for an unknown poll id', async () => {
      await gateway.simulatePollVote({
        pollId: 'no-such-poll',
        groupId: TEST_GROUP_ID,
        voter: IDENTITIES.alice,
        selectedOptions: ['Yes'],
        timestamp: new Date(),
      });

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(0);
    });
  });

  describe('replacement (FR-027)', () => {
    it('hard-deletes the prior poll + responses and posts a fresh one on force', async () => {
      await pollService.postOrReplaceNextPoll();
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['Yes']));
      const firstPollId = gateway.sentPolls[0]!.keyset.pollId;

      const result = await pollService.postOrReplaceNextPoll({ force: true });
      expect(result.outcome).toBe('replaced');
      expect(gateway.sentPolls).toHaveLength(2);

      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
      expect(polls[0]!.pollMessageId).not.toBe(firstPollId);

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(0);

      // Best-effort delete of the old WhatsApp poll message used the prior id.
      expect(gateway.deletedMessages).toHaveLength(1);
      expect(gateway.deletedMessages[0]!.id).toBe(firstPollId);
    });

    it('returns "exists" without sending again when a poll exists and force is not set', async () => {
      await pollService.postOrReplaceNextPoll();
      const result = await pollService.postOrReplaceNextPoll();

      expect(result.outcome).toBe('exists');
      expect(gateway.sentPolls).toHaveLength(1);
    });

    it('logs a warning but still completes replacement when the delete fails', async () => {
      await pollService.postOrReplaceNextPoll();
      gateway.deleteOutcomeOverride = { ok: false, reason: 'network' };
      const warnSpy = vi.spyOn(logger, 'warn');

      const result = await pollService.postOrReplaceNextPoll({ force: true });

      expect(result.outcome).toBe('replaced');
      expect(warnSpy).toHaveBeenCalled();
      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });

  describe('auto-pin the poll until game time (007)', () => {
    // A fixed, deterministic clock far in the past so the pin window is positive and the computed
    // duration is asserted without real-clock dependence (FR-008). Fixtures are still real-future
    // dated relative to the FixtureService's own clock, so the next fixture resolves normally.
    const FIXED_NOW = new Date('2020-06-01T12:00:00Z');

    /** Build a PollService whose pin window is computed against {@link FIXED_NOW}. */
    function clockedService(now: Date = FIXED_NOW): PollService {
      return new PollService(
        testDb.db,
        fixtureService,
        gateway,
        TEST_GROUP_ID,
        undefined,
        () => now
      );
    }

    it('pins the new poll for the window until game time (US1 P1/P7)', async () => {
      const result = await clockedService().postOrReplaceNextPoll();
      expect(result.outcome).toBe('posted');
      expect(gateway.pinnedMessages).toHaveLength(1);

      const pin = gateway.pinnedMessages[0]!;
      const sent = gateway.sentPolls[0]!;
      expect(pin.ref.id).toBe(sent.ref.id);

      // P7: durationSeconds equals floor((gameDate − now)/1000) exactly.
      const fixture = (result as Extract<typeof result, { fixture: unknown }>).fixture;
      const expected = Math.floor((fixture.gameDate.getTime() - FIXED_NOW.getTime()) / 1000);
      expect(pin.durationSeconds).toBe(expected);
    });

    it('previewNextPoll pins (and unpins) nothing (US1 P8)', async () => {
      await clockedService().previewNextPoll();
      expect(gateway.pinnedMessages).toHaveLength(0);
      expect(gateway.unpinnedMessages).toHaveLength(0);
    });

    it('unpins the old poll BEFORE deleting it, then pins the new one on force-replace (US2 P3)', async () => {
      const svc = clockedService();
      await svc.postOrReplaceNextPoll();
      const oldId = gateway.sentPolls[0]!.ref.id;

      const unpinSpy = vi.spyOn(gateway, 'unpinMessage');
      const deleteSpy = vi.spyOn(gateway, 'deleteMessage');

      const result = await svc.postOrReplaceNextPoll({ force: true });
      expect(result.outcome).toBe('replaced');

      expect(gateway.unpinnedMessages.map((r) => r.id)).toContain(oldId);
      expect(gateway.deletedMessages.map((r) => r.id)).toContain(oldId);
      // The unpin must precede the delete (FR-005).
      expect(unpinSpy.mock.invocationCallOrder[0]!).toBeLessThan(
        deleteSpy.mock.invocationCallOrder[0]!
      );
      // The freshly posted poll is pinned.
      const newId = gateway.sentPolls[1]!.ref.id;
      expect(gateway.pinnedMessages.map((p) => p.ref.id)).toContain(newId);

      unpinSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('still unpins before a FAILING delete and completes replacement (US2 P4)', async () => {
      const svc = clockedService();
      await svc.postOrReplaceNextPoll();
      const oldId = gateway.sentPolls[0]!.ref.id;
      gateway.deleteOutcomeOverride = { ok: false, reason: 'network' };

      const unpinSpy = vi.spyOn(gateway, 'unpinMessage');
      const deleteSpy = vi.spyOn(gateway, 'deleteMessage');

      const result = await svc.postOrReplaceNextPoll({ force: true });
      expect(result.outcome).toBe('replaced');
      expect(gateway.unpinnedMessages.map((r) => r.id)).toContain(oldId);
      expect(unpinSpy.mock.invocationCallOrder[0]!).toBeLessThan(
        deleteSpy.mock.invocationCallOrder[0]!
      );
      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);

      unpinSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('still posts, persists, stamps and tracks votes when the PIN fails (US3 P2)', async () => {
      const svc = clockedService();
      gateway.pinOutcomeOverride = { ok: false, reason: 'unknown' };

      const result = await svc.postOrReplaceNextPoll();
      expect(result.outcome).toBe('posted');

      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
      expect(await svc.getLastPollPostedAt()).not.toBeNull();

      // A subsequent vote is still tracked (the failed pin did not break the flow).
      await gateway.simulatePollVote(voteFor(IDENTITIES.alice, ['Yes']));
      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
    });

    it('still completes replacement when the UNPIN fails (US3 P5)', async () => {
      const svc = clockedService();
      await svc.postOrReplaceNextPoll();
      gateway.unpinOutcomeOverride = { ok: false, reason: 'network' };

      const result = await svc.postOrReplaceNextPoll({ force: true });
      expect(result.outcome).toBe('replaced');
      expect(gateway.sentPolls).toHaveLength(2);
      const newId = gateway.sentPolls[1]!.ref.id;
      expect(gateway.pinnedMessages.map((p) => p.ref.id)).toContain(newId);
    });
  });

  it('uses teamId in setup', () => {
    expect(teamId).toBeGreaterThan(0);
  });
});
