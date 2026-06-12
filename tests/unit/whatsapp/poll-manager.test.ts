import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '#src/database/schema.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import { MockWhatsAppClient } from '../../helpers/mock-whatsapp.js';
import { PollManager } from '#src/whatsapp/poll-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('PollManager', () => {
  let testDb: TestDatabase;
  let client: MockWhatsAppClient;
  let manager: PollManager;

  beforeEach(async () => {
    testDb = createTestDatabase();
    const { db } = testDb;

    const migrationsFolder = resolve(__dirname, '../../../drizzle');
    migrate(db, { migrationsFolder });

    client = new MockWhatsAppClient();
    manager = new PollManager(client);

    const [team] = await db
      .insert(schema.teams)
      .values({ name: 'Test Team', clubUrl: 'https://manvfatfootball.com/club/watford/' })
      .returning();

    const [season] = await db
      .insert(schema.seasons)
      .values({ teamId: team!.id, seasonNumber: 1, isCurrent: true })
      .returning();

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db
      .insert(schema.games)
      .values({
        seasonId: season!.id,
        gameDate: futureDate,
        opponent: 'Red Devils',
        venue: 'Victoria Park',
        status: 'upcoming',
        scrapedUrl: null,
      });
  });

  afterEach(() => {
    testDb.close();
  });

  describe('formatPollQuestion', () => {
    it('should include opponent name in poll question', async () => {
      const [game] = await testDb.db.select().from(schema.games).limit(1);
      const question = manager.formatPollQuestion(game!);
      expect(question).toContain('Red Devils');
    });

    it('should return a non-empty string', async () => {
      const [game] = await testDb.db.select().from(schema.games).limit(1);
      const question = manager.formatPollQuestion(game!);
      expect(question.length).toBeGreaterThan(0);
    });
  });

  describe('getPollOptions', () => {
    it('should return standard availability options', () => {
      const options = manager.getPollOptions();
      expect(options).toContain('Yes');
      expect(options).toContain('No');
      expect(options.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('sendPoll', () => {
    it('should send poll via WhatsApp client', async () => {
      const [game] = await testDb.db.select().from(schema.games).limit(1);
      const messageId = await manager.sendPoll(game!, 'test-group@g.us');

      expect(client.sentPolls).toHaveLength(1);
      expect(client.sentPolls[0]!.groupJid).toBe('test-group@g.us');
      expect(typeof messageId).toBe('string');
      expect(messageId.length).toBeGreaterThan(0);
    });

    it('should include opponent name in poll question', async () => {
      const [game] = await testDb.db.select().from(schema.games).limit(1);
      await manager.sendPoll(game!, 'test-group@g.us');

      expect(client.sentPolls[0]!.poll.name).toContain('Red Devils');
    });

    it('should include selectableCount of 1', async () => {
      const [game] = await testDb.db.select().from(schema.games).limit(1);
      await manager.sendPoll(game!, 'test-group@g.us');

      expect(client.sentPolls[0]!.poll.selectableCount).toBe(1);
    });
  });
});
