// PURE message mapping: translate a Baileys WAMessage into the public IncomingMessage,
// and decide whether an upsert item is genuine new inbound (FR-014/FR-015).
//
// Verified against the official Baileys docs (baileys.wiki — "Receiving Updates" and
// "Handling Messages") and research.md §2:
//   • messages.upsert delivers { type: 'notify' | 'append', messages: WAMessage[] }.
//     'notify' = newly received → route to the consumer; 'append' = history / echo
//     (our own sent message/poll comes back as 'append') → NOT new inbound (FR-015).
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

/** The two upsert kinds Baileys emits (official docs: notify = new, append = history/echo). */
export type UpsertType = 'notify' | 'append';

/**
 * True for a LIVE inbound message: any `'notify'` item (FR-014/FR-015).
 *
 * Dispatch is gated on the upsert `type`, NOT on `fromMe`. The bot is linked to the
 * operator's own WhatsApp account, so the operator is a **participant**: messages they type
 * in the group from their own phone arrive as `'notify'` + `fromMe: true` and ARE genuine
 * new inbound activity. The gateway's own *programmatic* sends (`sendMessage`/`sendPoll`) and
 * history backfill on resync arrive as `'append'`, so they remain excluded here — that, not a
 * `fromMe` check, is what filters out "echoes of its own activity" (FR-015). `mapIncomingMessage`
 * still records `fromMe` faithfully so consumers can branch on who sent it.
 */
export function isNewInbound(type: UpsertType, _msg: WAMessage): boolean {
  return type === 'notify';
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
