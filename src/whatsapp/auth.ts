/**
 * Database-backed WhatsApp authentication state
 * Stores Baileys credentials and signal keys in SQLite via Drizzle ORM
 */

import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalKeyStore } from '@whiskeysockets/baileys';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and, inArray } from 'drizzle-orm';
import * as schema from '../database/schema.js';

// Key IDs are prefixed with teamId-seasonId to support multi-team without schema changes
function makeStoreId(teamId: number, seasonId: number, type: string, id: string): string {
  return `${teamId}-${seasonId}-${type}-${id}`;
}

function makeCredsId(teamId: number, seasonId: number): string {
  return `${teamId}-${seasonId}-creds`;
}

function extractId(storeId: string, teamId: number, seasonId: number, type: string): string {
  const prefix = `${teamId}-${seasonId}-${type}-`;
  return storeId.startsWith(prefix) ? storeId.slice(prefix.length) : storeId;
}

async function writeAuthRecord(
  db: BetterSQLite3Database<typeof schema>,
  id: string,
  teamId: number,
  seasonId: number,
  value: string
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.authStates.id })
    .from(schema.authStates)
    .where(eq(schema.authStates.id, id))
    .limit(1);

  if (existing) {
    await db
      .update(schema.authStates)
      .set({ value, updatedAt: new Date() })
      .where(eq(schema.authStates.id, id));
  } else {
    await db.insert(schema.authStates).values({ id, teamId, seasonId, value });
  }
}

/**
 * Create a database-backed Baileys auth state
 */
export async function useDatabaseAuthState(
  db: BetterSQLite3Database<typeof schema>,
  teamId: number,
  seasonId: number
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearAuth: () => Promise<void>;
}> {
  const credsId = makeCredsId(teamId, seasonId);

  const [credsRow] = await db
    .select()
    .from(schema.authStates)
    .where(eq(schema.authStates.id, credsId))
    .limit(1);

  const creds = credsRow
    ? (JSON.parse(credsRow.value, BufferJSON.reviver) as ReturnType<typeof initAuthCreds>)
    : initAuthCreds();

  const keys: SignalKeyStore = {
    async get(type, ids) {
      const storeIds = ids.map(id => makeStoreId(teamId, seasonId, type, id));
      const rows = await db
        .select()
        .from(schema.authStates)
        .where(inArray(schema.authStates.id, storeIds));

      const result: Record<string, unknown> = {};
      for (const row of rows) {
        const id = extractId(row.id, teamId, seasonId, type);
        result[id] = JSON.parse(row.value, BufferJSON.reviver);
      }
      // The generic T is erased at runtime; we trust the JSON round-trip to preserve the structure.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result as any;
    },

    async set(data) {
      for (const [type, typeData] of Object.entries(data)) {
        if (!typeData) continue;

        for (const [id, value] of Object.entries(typeData)) {
          const storeId = makeStoreId(teamId, seasonId, type, id);

          if (value != null) {
            const serialized = JSON.stringify(value, BufferJSON.replacer);
            await writeAuthRecord(db, storeId, teamId, seasonId, serialized);
          } else {
            await db
              .delete(schema.authStates)
              .where(
                and(
                  eq(schema.authStates.id, storeId),
                  eq(schema.authStates.teamId, teamId),
                  eq(schema.authStates.seasonId, seasonId)
                )
              );
          }
        }
      }
    },
  };

  return {
    state: { creds, keys },

    saveCreds: async () => {
      const serialized = JSON.stringify(creds, BufferJSON.replacer);
      await writeAuthRecord(db, credsId, teamId, seasonId, serialized);
    },

    clearAuth: async () => {
      const allKeys = await db
        .select({ id: schema.authStates.id })
        .from(schema.authStates)
        .where(
          and(
            eq(schema.authStates.teamId, teamId),
            eq(schema.authStates.seasonId, seasonId)
          )
        );

      if (allKeys.length > 0) {
        await db
          .delete(schema.authStates)
          .where(
            inArray(
              schema.authStates.id,
              allKeys.map(k => k.id)
            )
          );
      }
    },
  };
}
