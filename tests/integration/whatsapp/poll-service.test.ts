import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { MockWhatsAppClient } from '../../helpers/mock-whatsapp.js';
import { PollService } from '#src/services/poll-service.js';
import { SeasonService } from '#src/services/season-service.js';
import { FixtureService } from '#src/services/fixture-service.js';
import { MockFixtureScraper } from '../../helpers/mock-scraper.js';
import type { PollVoteResult } from '#src/types/whatsapp.js';
import { logger } from '#src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GROUP_JID = 'test-group@g.us';

describe('PollService Integration Tests', () => {
  let testDb: TestDatabase;
  let client: MockWhatsAppClient;
  let pollService: PollService;
  let teamId: number;
  let gameId: number;

  beforeEach(async () => {
    testDb = createTestDatabase();
    const { db } = testDb;

    const migrationsFolder = resolve(__dirname, '../../../drizzle');
    migrate(db, { migrationsFolder });

    client = new MockWhatsAppClient();

    const seasonService = new SeasonService(db);
    const fixtureService = new FixtureService(db, seasonService, new MockFixtureScraper());
    pollService = new PollService(db, fixtureService, client, GROUP_JID);

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();
    teamId = team!.id;

    const [season] = await db
      .insert(schema.seasons)
      .values({ teamId, seasonNumber: 1, isCurrent: true })
      .returning();

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [game] = await db
      .insert(schema.games)
      .values({
        seasonId: season!.id,
        gameDate: futureDate,
        opponent: 'Red Devils',
        venue: 'Victoria Park',
        status: 'upcoming',
        scrapedUrl: null,
      })
      .returning();
    gameId = game!.id;
  });

  afterEach(() => {
    testDb.close();
  });

  describe('postPollForGame', () => {
    it('should post poll and return message ID', async () => {
      const messageId = await pollService.postPollForGame(gameId);

      expect(typeof messageId).toBe('string');
      expect(messageId!.length).toBeGreaterThan(0);
      expect(client.sentPolls).toHaveLength(1);
    });

    it('should store poll in database after posting', async () => {
      await pollService.postPollForGame(gameId);

      const hasPoll = await pollService.hasPollForGame(gameId);
      expect(hasPoll).toBe(true);
    });

    it('should not double-post without --force', async () => {
      await pollService.postPollForGame(gameId);
      const result = await pollService.postPollForGame(gameId);

      expect(result).toBeNull();
      expect(client.sentPolls).toHaveLength(1);
    });

    it('should force re-post with { force: true }', async () => {
      await pollService.postPollForGame(gameId);
      const result = await pollService.postPollForGame(gameId, { force: true });

      expect(result).not.toBeNull();
      expect(client.sentPolls).toHaveLength(2);
    });

    it('should return null for non-existent game', async () => {
      const result = await pollService.postPollForGame(99999);
      expect(result).toBeNull();
    });
  });

  describe('postPollForNextGame', () => {
    it('should post poll for next upcoming game', async () => {
      const messageId = await pollService.postPollForNextGame(teamId);

      expect(messageId).not.toBeNull();
      expect(client.sentPolls).toHaveLength(1);
      expect(client.sentPolls[0]!.poll.name).toContain('Red Devils');
    });

    it('should return null when no upcoming games', async () => {
      // Mark the game as completed
      await testDb.db.update(schema.games).set({ status: 'completed' });

      const result = await pollService.postPollForNextGame(teamId);
      expect(result).toBeNull();
    });
  });

  describe('getPoll', () => {
    it('should return null when no poll for game', async () => {
      const poll = await pollService.getPoll(gameId);
      expect(poll).toBeNull();
    });

    it('should return poll after posting', async () => {
      await pollService.postPollForGame(gameId);

      const poll = await pollService.getPoll(gameId);
      expect(poll).not.toBeNull();
      expect(poll!.gameId).toBe(gameId);
    });
  });

  describe('hasPollForGame', () => {
    it('should return false before any poll posted', async () => {
      expect(await pollService.hasPollForGame(gameId)).toBe(false);
    });

    it('should return true after poll posted', async () => {
      await pollService.postPollForGame(gameId);
      expect(await pollService.hasPollForGame(gameId)).toBe(true);
    });
  });

  describe('handlePollVote', () => {
    it('should record votes by messageId', async () => {
      const messageId = await pollService.postPollForGame(gameId);

      const votes: PollVoteResult[] = [
        { optionName: 'Yes', voters: ['1234567890@s.whatsapp.net'], voteCount: 1 },
      ];
      await pollService.handlePollVote(messageId!, votes);

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.selectedOption).toBe('Yes');
    });

    it('should be a no-op for unknown message IDs', async () => {
      const votes: PollVoteResult[] = [
        { optionName: 'Yes', voters: ['1234567890@s.whatsapp.net'], voteCount: 1 },
      ];
      await pollService.handlePollVote('unknown-msg-id', votes);

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(0);
    });
  });

  describe('recordPollResponse', () => {
    it('should record user vote in database', async () => {
      const messageId = await pollService.postPollForGame(gameId);
      const poll = await pollService.getPoll(gameId);

      await pollService.recordPollResponse(poll!.id, '1234567890@s.whatsapp.net', 'Yes');

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.selectedOption).toBe('Yes');
    });

    it('should upsert vote for same user', async () => {
      await pollService.postPollForGame(gameId);
      const poll = await pollService.getPoll(gameId);

      await pollService.recordPollResponse(poll!.id, '1234567890@s.whatsapp.net', 'Yes');
      await pollService.recordPollResponse(poll!.id, '1234567890@s.whatsapp.net', 'No');

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.selectedOption).toBe('No');
    });
  });

  describe('poll replacement (FR-024)', () => {
    /** Post a poll and record one response against it; returns the old message ID. */
    async function postPollWithResponse(): Promise<string> {
      const oldMessageId = await pollService.postPollForGame(gameId);
      const poll = await pollService.getPoll(gameId);
      await pollService.recordPollResponse(
        poll!.id,
        '1234567890@s.whatsapp.net',
        'Yes'
      );
      return oldMessageId!;
    }

    it('hard-deletes the old poll and cascade-deletes its responses, leaving exactly one poll', async () => {
      const oldMessageId = await postPollWithResponse();

      await pollService.postPollForGame(gameId, { force: true });

      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
      // The surviving poll is the new one, not the original
      expect(polls[0]!.whatsappMessageId).not.toBe(oldMessageId);

      // Responses belonged to the deleted poll and were cascade-removed
      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(0);
    });

    it('best-effort deletes the old WhatsApp message with the prior message ID', async () => {
      const oldMessageId = await postPollWithResponse();

      await pollService.postPollForGame(gameId, { force: true });

      expect(client.deletedMessages).toHaveLength(1);
      expect(client.deletedMessages[0]!.messageId).toBe(oldMessageId);
      expect(client.deletedMessages[0]!.groupJid).toBe(GROUP_JID);
    });

    it('logs a warning but still completes replacement when deleteMessage fails', async () => {
      await postPollWithResponse();
      client.deleteShouldFail = true;
      const warnSpy = vi.spyOn(logger, 'warn');

      const result = await pollService.postPollForGame(gameId, { force: true });

      expect(result).not.toBeNull();
      expect(warnSpy).toHaveBeenCalled();

      // Replacement still happened: exactly one (new) poll remains
      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
      expect(polls[0]!.whatsappMessageId).toBe(result);

      warnSpy.mockRestore();
    });

    it('leaves the existing poll and responses intact when sendPoll throws', async () => {
      const oldMessageId = await postPollWithResponse();
      client.failNextSendPoll = true;

      await expect(
        pollService.postPollForGame(gameId, { force: true })
      ).rejects.toThrow();

      // No DB mutation occurred — original poll and its response survive
      const polls = await testDb.db.select().from(schema.polls);
      expect(polls).toHaveLength(1);
      expect(polls[0]!.whatsappMessageId).toBe(oldMessageId);

      const responses = await testDb.db.select().from(schema.pollResponses);
      expect(responses).toHaveLength(1);

      // Nothing was deleted from WhatsApp either
      expect(client.deletedMessages).toHaveLength(0);
    });
  });

  it('uses teamId in setup', () => {
    expect(teamId).toBeGreaterThan(0);
  });
});
