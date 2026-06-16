// PURE message mapping: translate a Baileys WAMessage into the public IncomingMessage,
// and decide whether an upsert item should be dispatched (the type-agnostic rule, FR-011).
//
// Verified against the official Baileys docs (baileys.wiki — "Receiving Updates" and
// "Handling Messages") and research.md §2:
//   • messages.upsert delivers { type: 'notify' | 'append', messages: WAMessage[] }.
//     'notify' = live, 'append' = offline catch-up re-delivered on reconnect (and own-send
//     echoes). Dispatch NO LONGER gates on this tag (FR-011): a recovered `append` item is
//     dispatched exactly as the equivalent live `notify` would be. The decision is the pure
//     {@link isDispatchable} below — authorization then the at-most-once claim — and own-send
//     echoes are suppressed by the send-time own-send claim, not by the upsert type (FR-004).
//   • Text lives in `message.conversation` or `message.extendedTextMessage.text`.
//   • Sender is `key.participant` in a group (with `key.participantAlt` as the LID/PN
//     counterpart); `messageTimestamp` is seconds (may be a Long).
//
// This unit is pure and unit-tested. It uses Baileys TYPES internally (allowed; the
// no-leak invariant applies only to the public surface, index.ts/types.ts). The sender
// is resolved to a canonical Identity via the injected IdentityResolver so LID/PN forms
// of one person never double-count (FR-025/FR-026); the gateway owns the resolver instance
// for the session and passes it in.
import type { WAMessage } from '@whiskeysockets/baileys';
import type { IncomingMessage } from '../types.js';
import type { IdentityResolver } from '../identity/identity-resolver.js';

/**
 * Decide whether an inbound upsert item should be dispatched — the type-agnostic dispatch
 * rule that supersedes the former notify-only gate (contract C1, FR-011).
 *
 * Two gates, evaluated in order; the first to fail stops dispatch:
 *   1. `authorized` — the single authorization chokepoint (`groupFilter.isAuthorized`,
 *      FR-005/SC-004). A cross-chat item is dropped here.
 *   2. `claim()` — the at-most-once guard (`messageStore.claimOnce`, FR-003). A failed claim
 *      means the item was already seen: an own-send echo (FR-004) or a re-delivery (FR-003).
 *
 * The decision deliberately ignores the Baileys upsert `type`, so a recovered `append` item
 * dispatches exactly as the equivalent live `notify` item would (G1/G4). `claim` is
 * side-effecting (test-and-set), so it is only invoked once authorization passes — an
 * unauthorized item must not consume a claim. `type` MAY be logged by the caller for debugging
 * but MUST NOT influence this result.
 */
export function isDispatchable(authorized: boolean, claim: () => boolean): boolean {
  if (!authorized) {
    return false;
  }
  return claim();
}

/**
 * Extract the text body from a WAMessage: `conversation` (plain) or
 * `extendedTextMessage.text` (reply/quoted/link-preview), else `null` for non-text
 * content. `??` is intentional so an explicit empty string is preserved rather than
 * masked as "no text".
 */
export function extractText(msg: WAMessage): string | null {
  const content = msg.message;
  if (!content) {
    return null;
  }
  const text = content.conversation ?? content.extendedTextMessage?.text;
  return text ?? null;
}

/**
 * Normalize a Baileys `messageTimestamp` (seconds — `number`, a `Long`, or absent) into a
 * JS `Date`. A `Long` exposes `toNumber()`; anything missing falls back to the epoch so the
 * field is always a valid `Date` (FR-014).
 */
export function normalizeTimestamp(ts: WAMessage['messageTimestamp']): Date {
  return new Date(toSeconds(ts) * 1000);
}

/**
 * Map a WAMessage to the public {@link IncomingMessage}, resolving the sender to a canonical
 * {@link Identity} via the injected resolver. The author of a group message is
 * `key.participant` (with `key.participantAlt` as the LID/PN counterpart); the group itself
 * is `key.remoteJid`.
 */
export function mapIncomingMessage(msg: WAMessage, resolver: IdentityResolver): IncomingMessage {
  const key = msg.key;
  const groupId = key?.remoteJid ?? '';
  // In a group the real author is `participant`; for a DM it would be `remoteJid`.
  const senderJid = key?.participant ?? key?.remoteJid ?? '';
  const senderAlt = key?.participantAlt ?? undefined;
  const sender = resolver.resolve(senderJid, senderAlt ?? undefined, msg.pushName ?? undefined);

  return {
    id: key?.id ?? '',
    groupId,
    sender,
    text: extractText(msg),
    timestamp: normalizeTimestamp(msg.messageTimestamp),
    fromMe: key?.fromMe === true,
  };
}

/** Coerce a `number | Long | null | undefined` seconds value to a plain number. */
function toSeconds(ts: WAMessage['messageTimestamp']): number {
  if (ts == null) {
    return 0;
  }
  if (typeof ts === 'number') {
    return ts;
  }
  // A Long instance — use its lossless-ish toNumber(); guard structurally to stay off the
  // `long` package import.
  const maybeLong = ts as { toNumber?: () => number };
  if (typeof maybeLong.toNumber === 'function') {
    return maybeLong.toNumber();
  }
  return Number(ts) || 0;
}
