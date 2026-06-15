import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import * as schema from '#src/database/schema.js';
import { CredentialsStore } from '#src/whatsapp/credentials-store.js';

describe('CredentialsStore (FR-008 — opaque snapshot persistence)', () => {
  let testDb: TestDatabase;
  let store: CredentialsStore;
  let teamId: number;

  beforeEach(async () => {
    testDb = createTestDatabase();
    store = new CredentialsStore(testDb.db);
    const [team] = await testDb.db
      .insert(schema.teams)
      .values({ name: 'Test FC', clubUrl: 'https://manvfatfootball.org/club/test' })
      .returning();
    teamId = team!.id;
  });

  afterEach(() => {
    testDb.close();
  });

  it('load() returns undefined when no snapshot is stored', async () => {
    expect(await store.load(teamId)).toBeUndefined();
  });

  it('load() returns the saved snapshot verbatim after save()', async () => {
    const snapshot = '{"opaque":"creds-blob","n":1}';
    await store.save(teamId, snapshot);
    expect(await store.load(teamId)).toBe(snapshot);
  });

  it('save() upserts a single row and bumps updatedAt (no duplicate rows)', async () => {
    await store.save(teamId, 'first');
    const [rowAfterFirst] = await testDb.db
      .select()
      .from(schema.gatewayCredentials)
      .where(eq(schema.gatewayCredentials.teamId, teamId));
    const firstUpdatedAt = rowAfterFirst!.updatedAt;

    await store.save(teamId, 'second');

    const rows = await testDb.db
      .select()
      .from(schema.gatewayCredentials)
      .where(eq(schema.gatewayCredentials.teamId, teamId));

    // Exactly one row per team (single-operator MVP) — second save overwrites, never appends.
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.snapshot).toBe('second');
    expect(row!.updatedAt).toBeInstanceOf(Date);
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(firstUpdatedAt.getTime());
    expect(await store.load(teamId)).toBe('second');
  });
});
