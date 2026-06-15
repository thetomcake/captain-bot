import { describe, it, expect } from 'vitest';
import { classifyDeleteError } from '#src/whatsapp-gateway/messages/delete-classifier.js';

// FR-028: deletion is best-effort. classifyDeleteError is the pure decision unit that maps a
// thrown revoke error to a DeleteOutcome failure reason — kept out of the untestable shell so the
// failure-mode mapping is unit-tested (implementation discipline).
//
// VERIFIED against the installed @whiskeysockets/baileys@7.0.0-rc13 source (FR-031): a revoke
// (`sock.sendMessage(jid, { delete: key })`) is FIRE-AND-FORGET — `relayMessage` awaits only the
// WebSocket write (`Socket/socket.js` sendNode → sendRawMessage), never a server ack. So a
// server-side rejection (revoke-window elapsed, message already gone, insufficient privilege) is
// NEVER thrown; it fails silently server-side. The ONLY errors reaching the catch are transport /
// precondition Boom errors: 428 Connection Closed, 408 Timed Out, 503 unavailable, 500 "All
// encryptions failed", 401 "Not authenticated". Hence the classifier returns only `network` or
// `unknown` — the `window-expired`/`not-found` reasons in DeleteOutcome are reserved and never
// produced (a grep of lib/ confirms those strings never appear in a thrown error).
describe('classifyDeleteError (FR-028)', () => {
  it('classifies a connection-closed (Boom 428) error as network', () => {
    const boom = { message: 'Connection Closed', output: { statusCode: 428 } };
    expect(classifyDeleteError(boom)).toEqual({ reason: 'network', detail: 'Connection Closed' });
  });

  it('classifies a timed-out (Boom 408) error as network', () => {
    const boom = { message: 'Timed Out', output: { statusCode: 408 } };
    expect(classifyDeleteError(boom).reason).toBe('network');
  });

  it('classifies an unavailable-service (Boom 503) error as network', () => {
    const boom = { message: 'Service Unavailable', output: { statusCode: 503 } };
    expect(classifyDeleteError(boom).reason).toBe('network');
  });

  it('classifies status-less raw transport errors as network (keyword fallback)', () => {
    expect(classifyDeleteError(new Error('socket hang up')).reason).toBe('network');
    expect(classifyDeleteError(new Error('read ECONNRESET')).reason).toBe('network');
    expect(classifyDeleteError(new Error('Connection lost')).reason).toBe('network');
  });

  it('classifies "All encryptions failed" (Boom 500) as unknown, NOT network', () => {
    // A 5xx here is an encryption fault, not a transient network drop — do not mislabel it.
    const boom = { message: 'All encryptions failed', output: { statusCode: 500 } };
    expect(classifyDeleteError(boom).reason).toBe('unknown');
  });

  it('classifies "Not authenticated" (Boom 401) as unknown', () => {
    const boom = { message: 'Not authenticated', output: { statusCode: 401 } };
    expect(classifyDeleteError(boom).reason).toBe('unknown');
  });

  it('does NOT pretend to detect server-side revoke rejections (reserved reasons never returned)', () => {
    // Baileys never throws these; if some wrapper ever did, we still report `unknown` rather than
    // fabricate a `window-expired`/`not-found` outcome we cannot actually observe.
    expect(classifyDeleteError(new Error('revoke window expired')).reason).toBe('unknown');
    expect(classifyDeleteError(new Error('message not found')).reason).toBe('unknown');
  });

  it('falls back to unknown for an unrecognized error, preserving the detail', () => {
    const out = classifyDeleteError(new Error('something weird happened'));
    expect(out.reason).toBe('unknown');
    expect(out.detail).toBe('something weird happened');
  });

  it('never throws on non-Error inputs and reports unknown', () => {
    expect(classifyDeleteError(undefined).reason).toBe('unknown');
    expect(classifyDeleteError(null).reason).toBe('unknown');
    expect(classifyDeleteError('plain string').reason).toBe('unknown');
    expect(classifyDeleteError('plain string').detail).toBe('plain string');
  });
});
