import { describe, it, expect } from 'vitest';
import {
  isNewInbound,
  extractText,
  normalizeTimestamp,
  mapIncomingMessage,
} from '#src/whatsapp-gateway/messages/message-mapper.js';
import { IdentityResolver } from '#src/whatsapp-gateway/identity/identity-resolver.js';
import type { WAMessage } from '@whiskeysockets/baileys';

// Build a minimal WAMessage-shaped object. We use the real Baileys WAMessage TYPE (not a
// mock of the library — tests/README service-boundary rule) and only populate the fields the
// mapper reads. Cast through unknown so partial fixtures are accepted under strict TS.
function makeMessage(overrides: {
  remoteJid?: string;
  participant?: string;
  participantAlt?: string;
  fromMe?: boolean;
  id?: string;
  message?: WAMessage['message'];
  messageTimestamp?: WAMessage['messageTimestamp'];
  pushName?: string;
}): WAMessage {
  return {
    key: {
      remoteJid: overrides.remoteJid ?? '123456789@g.us',
      fromMe: overrides.fromMe ?? false,
      id: overrides.id ?? 'MSGID',
      participant: overrides.participant,
      participantAlt: overrides.participantAlt,
    },
    message: overrides.message,
    messageTimestamp: overrides.messageTimestamp,
    pushName: overrides.pushName,
  } as unknown as WAMessage;
}

const PN = '447700900123@s.whatsapp.net';
const LID = '111222333@lid';

describe('isNewInbound (live-vs-history; the linked account is a participant — FR-014/FR-015)', () => {
  it('reports a genuine notify message from another person', () => {
    expect(isNewInbound('notify', makeMessage({ fromMe: false }))).toBe(true);
  });

  it('reports the operator’s OWN manual message (notify + fromMe) — they are a participant', () => {
    // The bot is linked to the operator's own account; messages they type on their phone
    // arrive as notify + fromMe and ARE live inbound activity. Dispatch is gated on `type`,
    // not `fromMe`.
    expect(isNewInbound('notify', makeMessage({ fromMe: true }))).toBe(true);
  });

  it('does NOT report an append message (history / our own programmatic-send echo)', () => {
    expect(isNewInbound('append', makeMessage({ fromMe: false }))).toBe(false);
  });

  it('does NOT report an append message even when fromMe (history backfill of own activity)', () => {
    // The gateway's own programmatic sends and resync history arrive as `append`; they must
    // stay excluded regardless of fromMe. This guards against a refactor re-introducing a
    // fromMe-only gate that would resurrect history.
    expect(isNewInbound('append', makeMessage({ fromMe: true }))).toBe(false);
  });
});

describe('extractText (FR-014)', () => {
  it('reads a plain conversation message', () => {
    expect(extractText(makeMessage({ message: { conversation: 'hello there' } }))).toBe(
      'hello there'
    );
  });

  it('reads an extendedTextMessage (e.g. reply/quoted) text', () => {
    expect(
      extractText(makeMessage({ message: { extendedTextMessage: { text: 'extended body' } } }))
    ).toBe('extended body');
  });

  it('prefers conversation when both are somehow present', () => {
    expect(
      extractText(
        makeMessage({
          message: { conversation: 'primary', extendedTextMessage: { text: 'secondary' } },
        })
      )
    ).toBe('primary');
  });

  it('returns null when there is no text content', () => {
    expect(extractText(makeMessage({ message: { imageMessage: {} } }))).toBeNull();
  });

  it('returns null when the message envelope is absent', () => {
    expect(extractText(makeMessage({ message: undefined }))).toBeNull();
  });
});

describe('normalizeTimestamp (seconds → Date, FR-014)', () => {
  it('normalizes a numeric seconds timestamp to a Date (ms)', () => {
    const seconds = 1_700_000_000;
    expect(normalizeTimestamp(seconds)).toEqual(new Date(seconds * 1000));
  });

  it('normalizes a Long-like timestamp (has toNumber) to a Date', () => {
    const seconds = 1_700_000_123;
    const longLike = { toNumber: () => seconds } as unknown as WAMessage['messageTimestamp'];
    expect(normalizeTimestamp(longLike)).toEqual(new Date(seconds * 1000));
  });

  it('falls back to the epoch when the timestamp is missing', () => {
    expect(normalizeTimestamp(undefined)).toEqual(new Date(0));
    expect(normalizeTimestamp(null)).toEqual(new Date(0));
  });
});

describe('mapIncomingMessage (WAMessage → IncomingMessage)', () => {
  it('maps a group notify message to the public IncomingMessage shape', () => {
    const seconds = 1_700_000_000;
    const incoming = mapIncomingMessage(
      makeMessage({
        remoteJid: '123456789@g.us',
        id: 'ABC123',
        participant: PN,
        fromMe: false,
        message: { conversation: 'gm all' },
        messageTimestamp: seconds,
        pushName: 'Alice',
      }),
      new IdentityResolver()
    );

    expect(incoming.id).toBe('ABC123');
    expect(incoming.groupId).toBe('123456789@g.us');
    expect(incoming.text).toBe('gm all');
    expect(incoming.timestamp).toEqual(new Date(seconds * 1000));
    expect(incoming.fromMe).toBe(false);
    expect(incoming.sender.canonicalId).toBe(PN);
    expect(incoming.sender.pn).toBe(PN);
    expect(incoming.sender.displayHint).toBe('Alice');
  });

  it('resolves the sender to one canonical identity across LID/PN forms', () => {
    // participant arrives as LID with its PN counterpart in participantAlt — the resolver
    // must reconcile them to a single canonical id (prefers PN) with no double-identity.
    const incoming = mapIncomingMessage(
      makeMessage({
        participant: LID,
        participantAlt: PN,
        message: { conversation: 'hi' },
        messageTimestamp: 1,
      }),
      new IdentityResolver()
    );

    expect(incoming.sender.canonicalId).toBe(PN);
    expect(incoming.sender.pn).toBe(PN);
    expect(incoming.sender.lid).toBe(LID);
  });

  it('maps a text-less message with a null text body', () => {
    const incoming = mapIncomingMessage(
      makeMessage({ participant: PN, message: { imageMessage: {} }, messageTimestamp: 1 }),
      new IdentityResolver()
    );
    expect(incoming.text).toBeNull();
  });
});
