// Bounded, in-memory LRU cache of recently sent/received messages (research.md §2/§7).
//
// This is INTERNAL infrastructure — never exported from index.ts, never persisted,
// empty after a restart. It uses Baileys types internally (allowed; the no-leak
// invariant applies only to the public surface). Two jobs:
//   1. Back Baileys' `getMessage(key)` so our outbound messages/polls are re-sent
//      when a recipient requests a retry-receipt (§2). A miss returns `undefined`.
//   2. Be the FIRST-choice source of a poll's `messageSecret` + option names while
//      the poll-creation message is still cached this session (§7); the consumer's
//      `resolvePollKeyset` keyset is the durable, restart-proof fallback.
//
// Keyed by `${remoteJid}:${id}`. Bounded LRU: on overflow the least-recently-used
// entry is evicted; both `set` and reads mark an entry as most-recently-used.
import type { WAMessage, proto } from '@whiskeysockets/baileys';

const DEFAULT_MAX_SIZE = 1000;

/** Compose the store key from a remote JID and message id. */
export function messageStoreKey(remoteJid: string | null | undefined, id: string | null | undefined): string {
  return `${remoteJid ?? ''}:${id ?? ''}`;
}

export class MessageStore {
  // A Map preserves insertion order; we use that to track recency (oldest first).
  private readonly entries = new Map<string, WAMessage>();

  constructor(private readonly maxSize: number = DEFAULT_MAX_SIZE) {}

  /** Cache a message (sent or received). No-op if it lacks a usable key. */
  set(msg: WAMessage): void {
    const remoteJid = msg.key?.remoteJid;
    const id = msg.key?.id;
    if (!remoteJid || !id) {
      return;
    }
    const key = messageStoreKey(remoteJid, id);
    // Re-insert to mark most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, msg);
    this.evictIfNeeded();
  }

  /**
   * Return the message *content* for Baileys send-retries (`proto.IMessage`), or
   * `undefined` on a miss. Bumps recency on a hit.
   */
  getMessage(key: string): proto.IMessage | undefined {
    const msg = this.touch(key);
    return msg?.message ?? undefined;
  }

  /**
   * Return the full cached poll-creation message for the poll-secret fast-path,
   * or `undefined` if it is no longer cached this session. Bumps recency on a hit.
   */
  getByPollId(groupId: string, pollId: string): WAMessage | undefined {
    return this.touch(messageStoreKey(groupId, pollId));
  }

  /** Remove a cached message (e.g. after a successful delete). */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Current number of cached messages (for tests/introspection). */
  get size(): number {
    return this.entries.size;
  }

  private touch(key: string): WAMessage | undefined {
    const msg = this.entries.get(key);
    if (msg) {
      this.entries.delete(key);
      this.entries.set(key, msg);
    }
    return msg;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxSize) {
      // The first key in iteration order is the least-recently-used.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}
