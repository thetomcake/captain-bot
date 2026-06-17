/**
 * Poll-keyset store (T027) — the MVP is the durable owner of each poll's decryption keyset
 * (FR-012/FR-014). The Gateway keeps no durable copy of a poll's `messageSecret`, so we persist it
 * (with `groupId` and the exact option strings) onto the poll row at `sendPoll` time and hand it
 * back on demand via {@link KeysetStore.resolve}, which `gateway-factory.ts` wires to
 * `resolvePollKeyset`.
 *
 * One poll id, not two: the keyset's `pollId` is the poll-creation message id (research §3), stored
 * once as `pollMessageId` and reused as the `deleteMessage` target.
 */
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../database/schema.js';
import type { Poll } from '../types/entities.js';
import type { PollKeyset, PollRef } from './gateway-port.js';

export interface PersistKeysetInput {
  gameId: number;
  question: string;
  postedAt: Date;
  keyset: PollKeyset;
}

export class KeysetStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Write a new poll row carrying its keyset (`messageSecret` + `groupId` + exact `options`) at
   * `sendPoll` time. The caller guarantees no live poll row exists for the game (replacement
   * hard-deletes first), so this respects the `unique(gameId)` constraint.
   */
  async persist(input: PersistKeysetInput): Promise<Poll> {
    const [row] = await this.db
      .insert(schema.polls)
      .values({
        gameId: input.gameId,
        pollMessageId: input.keyset.pollId,
        groupId: input.keyset.groupId,
        messageSecret: input.keyset.messageSecret,
        postedAt: input.postedAt,
        pollQuestion: input.question,
        pollOptions: input.keyset.options,
      })
      .returning();
    return row!;
  }

  /**
   * Reconstruct a poll's keyset from its row, matched by `pollMessageId == ref.pollId AND
   * groupId == ref.groupId`. Returns `null` for an unknown/replaced poll so the Gateway skips
   * that vote without error (FR-014).
   */
  async resolve(ref: PollRef): Promise<PollKeyset | null> {
    const [poll] = await this.db
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
}
