import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityResolver } from '#src/whatsapp-gateway/identity/identity-resolver.js';

const PN = '12345678901@s.whatsapp.net';
const PN_WITH_DEVICE = '12345678901:5@s.whatsapp.net';
const LID = '98765@lid';
const LID_WITH_DEVICE = '98765:2@lid';

describe('IdentityResolver (FR-025/FR-026)', () => {
  let resolver: IdentityResolver;

  beforeEach(() => {
    resolver = new IdentityResolver();
  });

  it('strips the device suffix from a PN JID', () => {
    const id = resolver.resolve(PN_WITH_DEVICE);
    expect(id.canonicalId).toBe(PN);
    expect(id.pn).toBe(PN);
  });

  it('strips the device suffix from a LID JID', () => {
    const id = resolver.resolve(LID_WITH_DEVICE);
    expect(id.lid).toBe(LID);
    expect(id.canonicalId).toBe(LID);
  });

  it('prefers the PN form as canonicalId when both forms are present (LID primary + PN alt)', () => {
    const id = resolver.resolve(LID, PN);
    expect(id.canonicalId).toBe(PN);
    expect(id.pn).toBe(PN);
    expect(id.lid).toBe(LID);
  });

  it('prefers the PN form as canonicalId when both forms are present (PN primary + LID alt)', () => {
    const id = resolver.resolve(PN, LID);
    expect(id.canonicalId).toBe(PN);
    expect(id.pn).toBe(PN);
    expect(id.lid).toBe(LID);
  });

  it('resolves LID and PN forms of one person to a single canonicalId (alt present)', () => {
    // Seen first as PN in chat (with LID alt), later as LID in a vote (with PN alt).
    const fromChat = resolver.resolve(PN, LID);
    const fromVote = resolver.resolve(LID, PN);
    expect(fromVote.canonicalId).toBe(fromChat.canonicalId);
    expect(fromVote.canonicalId).toBe(PN);
  });

  it('does not double-count across calls once the LID↔PN mapping has been learned from an alt', () => {
    // First call carries the counterpart, so the resolver learns LID → PN.
    resolver.resolve(PN, LID);
    // A later LID-only sighting (no alt) must still canonicalize to the PN form.
    const later = resolver.resolve(LID);
    expect(later.canonicalId).toBe(PN);
    expect(later.pn).toBe(PN);
    expect(later.lid).toBe(LID);
  });

  it('learns the mapping regardless of which form arrives first (LID first, then PN-only)', () => {
    resolver.resolve(LID, PN);
    const pnOnly = resolver.resolve(PN);
    expect(pnOnly.canonicalId).toBe(PN);
    expect(pnOnly.lid).toBe(LID);
  });

  it('falls back to the normalized LID as canonicalId when no PN counterpart is known', () => {
    const id = resolver.resolve(LID);
    expect(id.canonicalId).toBe(LID);
    expect(id.pn).toBeUndefined();
  });

  it('carries a display hint when provided', () => {
    const id = resolver.resolve(PN, undefined, 'Alice');
    expect(id.displayHint).toBe('Alice');
  });

  it('ignores an alt that is the same identity form as the primary', () => {
    // Two PN forms (e.g. primary + a PN alt) — no LID is learned.
    const id = resolver.resolve(PN, PN_WITH_DEVICE);
    expect(id.canonicalId).toBe(PN);
    expect(id.lid).toBeUndefined();
  });
});
