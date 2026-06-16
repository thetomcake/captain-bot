import { describe, it, expect } from 'vitest';
import {
  isDispatchable,
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

describe('isDispatchable (type-agnostic dispatch decision — contract C1, FR-011)', () => {
  // The decision rests on two gates only — the single authorization chokepoint (FR-005) and
  // the at-most-once claim (FR-003) — and is deliberately blind to the upsert `type`, so a
  // recovered `append` item dispatches exactly as the equivalent live `notify` item would.

  it('dispatches an authorized, unclaimed item (both gates pass — G1)', () => {
    expect(isDispatchable(true, () => true)).toBe(true);
  });

  it('drops an unauthorized item without consuming a claim (authorization gate — G2)', () => {
    // Order matters: authorization fails first, so the side-effecting claim is never spent on
    // a cross-chat item that will be dropped anyway (contract C1 ordering, FR-005/SC-004).
    let claimCalls = 0;
    const claim = () => {
      claimCalls += 1;
      return true;
    };
    expect(isDispatchable(false, claim)).toBe(false);
    expect(claimCalls).toBe(0);
  });

  it('suppresses an authorized item whose claim fails — already seen (claim gate — G3)', () => {
    // A failed claim means an own-send echo (FR-004) or a re-delivery (FR-003) — at-most-once.
    expect(isDispatchable(true, () => false)).toBe(false);
  });

  it('is independent of the upsert type — equal (authorized, claim) ⇒ equal result (G4)', () => {
    // `isDispatchable` takes no `type`: by construction the live/not-live tag cannot affect
    // dispatch. Whether the item arrived as `notify` or `append`, equal inputs yield equal
    // outputs — this is what relaxes the old notify-only gate (FR-011).
    for (const _type of ['notify', 'append'] as const) {
      expect(isDispatchable(true, () => true)).toBe(true);
      expect(isDispatchable(false, () => true)).toBe(false);
      expect(isDispatchable(true, () => false)).toBe(false);
    }
  });
});

describe('recovered (append) item eligibility & routing (US1, contract C1 G1/G4)', () => {
  // A vote cast/changed during an outage is re-delivered on reconnect as an `append` item.
  // The pure dispatch decision admits it exactly as the live `notify` equivalent, and the
  // poll-vote discriminator the gateway routes on (`message.pollUpdateMessage`) does not look
  // at the upsert type — so a recovered poll-update routes to the poll path (FR-001).

  // The exact branch `handleMessagesUpsert` uses to send an item to the poll-vote path.
  const isPollVote = (msg: WAMessage): boolean => msg.message?.pollUpdateMessage != null;

  it('a recovered authorized poll-update item is dispatchable and routes to the poll path (G1)', () => {
    const recovered = makeMessage({
      message: { pollUpdateMessage: { vote: {} } } as unknown as WAMessage['message'],
    });
    // authorized chat + unclaimed (first sighting) ⇒ both gates pass.
    expect(isDispatchable(true, () => true)).toBe(true);
    // …and it is identified as a poll vote, so it routes to onPollVote, not onMessage.
    expect(isPollVote(recovered)).toBe(true);
  });

  it('eligibility does not depend on the item being live — append behaves as notify (G4)', () => {
    // The recovered item carries no `type` into the decision; an equivalent live poll-update
    // yields the same dispatchable result. The live/not-live tag no longer affects dispatch.
    const live = makeMessage({
      message: { pollUpdateMessage: { vote: {} } } as unknown as WAMessage['message'],
    });
    expect(isDispatchable(true, () => true)).toBe(true);
    expect(isPollVote(live)).toBe(true);
  });
});

describe('recovered (append) text-message eligibility & routing (US2, contract C1 G1/G2)', () => {
  // A group message posted during an outage is re-delivered on reconnect as an `append` item.
  // The pure dispatch decision admits an authorized one exactly as the live `notify` equivalent
  // would be and — having no `pollUpdateMessage` — it routes to the onMessage text path
  // (FR-001/FR-002, G1). An `append` item from an unauthorized chat is dropped at the
  // authorization gate regardless of type (FR-005/SC-004, G2).

  // The exact branch `handleMessagesUpsert` uses to send an item to the poll-vote path; false
  // here means the item maps to onMessage.
  const isPollVote = (msg: WAMessage): boolean => msg.message?.pollUpdateMessage != null;

  it('a recovered authorized text item is dispatchable and maps to onMessage (G1)', () => {
    const recovered = makeMessage({
      remoteJid: '123456789@g.us',
      participant: PN,
      message: { conversation: 'sent while you were offline' },
      messageTimestamp: 1_700_000_000,
    });
    // authorized chat + unclaimed (first sighting) ⇒ both gates pass.
    expect(isDispatchable(true, () => true)).toBe(true);
    // …it is NOT a poll vote, so it routes to the onMessage text path, not onPollVote.
    expect(isPollVote(recovered)).toBe(false);
    // …and it maps cleanly to the public IncomingMessage the consumer receives — recovered text
    // is indistinguishable from a live message at the dispatch boundary.
    const incoming = mapIncomingMessage(recovered, new IdentityResolver());
    expect(incoming.text).toBe('sent while you were offline');
    expect(incoming.groupId).toBe('123456789@g.us');
    expect(incoming.sender.pn).toBe(PN);
  });

  it('a recovered item from an unauthorized chat is dropped before routing (G2)', () => {
    // The authorization gate fails first and no claim is consumed, so a cross-chat catch-up item
    // never reaches the routing branch — regardless of the upsert type (FR-005/SC-004).
    let claimCalls = 0;
    const claim = () => {
      claimCalls += 1;
      return true;
    };
    expect(isDispatchable(false, claim)).toBe(false);
    expect(claimCalls).toBe(0);
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
