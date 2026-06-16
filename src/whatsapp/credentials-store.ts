/**
 * Persistence for the Gateway's opaque credential snapshot (FR-008).
 *
 * The Gateway hands the MVP a `WhatsAppCredentials` string via `onCredentialsUpdate` and
 * `getCredentials()`; this store persists it verbatim in the single-row-per-team
 * `gateway_credentials` table and hands it back on the next start. The snapshot is a black
 * box — never parsed.
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '#src/database/schema.js';
import { gatewayCredentials } from '#src/database/schema.js';

export class CredentialsStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  /** Return the stored opaque snapshot for the team, or `undefined` if none is stored. */
  async load(teamId: number): Promise<string | undefined> {
    const [row] = await this.db
      .select({ snapshot: gatewayCredentials.snapshot })
      .from(gatewayCredentials)
      .where(eq(gatewayCredentials.teamId, teamId))
      .limit(1);
    return row?.snapshot;
  }

  /** Upsert the team's snapshot (one row per team) and bump `updatedAt`. */
  async save(teamId: number, snapshot: string): Promise<void> {
    const now = new Date();
    await this.db
      .insert(gatewayCredentials)
      .values({ teamId, snapshot, updatedAt: now })
      .onConflictDoUpdate({
        target: gatewayCredentials.teamId,
        set: { snapshot, updatedAt: now },
      });
  }

  /** Discard the team's stored snapshot so the next `connect()` QR-pairs fresh (`connect --reset`). */
  async clear(teamId: number): Promise<void> {
    await this.db.delete(gatewayCredentials).where(eq(gatewayCredentials.teamId, teamId));
  }
}
