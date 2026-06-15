/**
 * Builds a configured real `WhatsAppGateway` wired to DB-backed callbacks (FR-006/FR-008).
 *
 * This is the only place the concrete Gateway is constructed. Services and commands consume the
 * returned instance through the {@link IWhatsAppGateway} port; the Gateway owns rate limiting,
 * reconnection, identity canonicalization and best-effort delete, so the factory leaves
 * `minMessageDelayMs`/`reconnect` at Gateway defaults (FR-010) and never re-implements them.
 */
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { WhatsAppGateway } from '#src/whatsapp-gateway/index.js';
import type { Logger as GatewayLogger, PollKeyset, PollRef } from '#src/whatsapp-gateway/index.js';
import * as schema from '#src/database/schema.js';
import { getDatabase } from '#src/database/client.js';
import { getEnv, requireAuthorizedGroupId } from '#src/config/env.js';
import { logger } from '#src/utils/logger.js';
import { CredentialsStore } from './credentials-store.js';

export interface CreateGatewayOptions {
  /**
   * Auth-only / group-discovery mode (`connect`, `list-groups`): pass `true` to build the Gateway
   * with no authorized group (`authorizedGroups: []`), so a group JID need not be configured yet.
   * Group-dependent commands (`daemon`, `poll`) leave this `false` and require `AUTHORIZED_GROUP_ID`.
   */
  discovery?: boolean;
  /** Override the DB (tests / non-singleton callers). Defaults to the app singleton. */
  db?: BetterSQLite3Database<typeof schema>;
}

/** Adapt the MVP's timestamped logger (FR-025) to the Gateway's variadic `Logger` shape. */
function adaptLogger(): GatewayLogger {
  const join = (args: unknown[]): string =>
    args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeStringify(a)))
      .join(' ');
  return {
    debug: (...a) => logger.debug(join(a)),
    info: (...a) => logger.info(join(a)),
    warn: (...a) => logger.warn(join(a)),
    error: (...a) => logger.error(join(a)),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Construct the real Gateway with credentials loaded from the DB and poll-keyset resolution
 * wired to the `polls` table. Async because the opaque credential snapshot is loaded up front.
 */
export async function createGateway(options: CreateGatewayOptions = {}): Promise<WhatsAppGateway> {
  const db = options.db ?? getDatabase().db;
  const env = getEnv();

  // Single-operator MVP: one team, one credential snapshot.
  const [team] = await db.select().from(schema.teams).limit(1);
  if (!team) {
    throw new Error('No team configured. Run "captain-stats init" first.');
  }
  const teamId = team.id;

  const credentialsStore = new CredentialsStore(db);
  const credentials = await credentialsStore.load(teamId);

  const authorizedGroups = options.discovery ? [] : [requireAuthorizedGroupId(env)];

  return new WhatsAppGateway({
    authorizedGroups,
    credentials,
    onCredentialsUpdate: (snapshot) => credentialsStore.save(teamId, snapshot),
    resolvePollKeyset: (ref) => resolvePollKeyset(db, ref),
    logger: adaptLogger(),
    // minMessageDelayMs / reconnect intentionally left at Gateway defaults (FR-010).
  });
}

/**
 * Reconstruct a poll's keyset from the `polls` row (FR-014). Looks the poll up by
 * `pollMessageId == ref.pollId AND groupId == ref.groupId`; returns `null` for an
 * unknown/replaced poll so the Gateway skips that vote without error.
 *
 * (T027 will move this into `keyset-store.resolve` and have the factory delegate to it.)
 */
async function resolvePollKeyset(
  db: BetterSQLite3Database<typeof schema>,
  ref: PollRef
): Promise<PollKeyset | null> {
  const [poll] = await db
    .select()
    .from(schema.polls)
    .where(and(eq(schema.polls.pollMessageId, ref.pollId), eq(schema.polls.groupId, ref.groupId)))
    .limit(1);
  if (!poll) return null;
  return {
    pollId: poll.pollMessageId,
    groupId: poll.groupId,
    messageSecret: poll.messageSecret,
    options: poll.pollOptions,
  };
}
