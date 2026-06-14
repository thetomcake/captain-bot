import { describe, it, expect } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import {
  classifyDisconnect,
  type DisconnectClass,
} from '#src/whatsapp-gateway/connection/disconnect-classifier.js';

// Pure mapping from a Baileys close status code → recover | terminal | restart
// (research.md §2). The status code is the only input; intentional operator
// closes never reach the classifier (handled by the reducer's flag, T020a).
describe('classifyDisconnect (research.md §2 status-code mapping)', () => {
  it('classifies 515 (restartRequired) as restart — the expected post-pairing handshake', () => {
    expect(classifyDisconnect(DisconnectReason.restartRequired)).toBe<DisconnectClass>('restart');
    expect(classifyDisconnect(515)).toBe('restart');
  });

  it('classifies 408 (connectionLost/timedOut — ambiguous) as recover', () => {
    // 408 is BOTH connectionLost and timedOut (research.md §2, finding 4): always recover.
    expect(classifyDisconnect(DisconnectReason.connectionLost)).toBe<DisconnectClass>('recover');
    expect(classifyDisconnect(DisconnectReason.timedOut)).toBe('recover');
    expect(classifyDisconnect(408)).toBe('recover');
  });

  it('classifies 428 (connectionClosed) and 503 (unavailableService) as recover', () => {
    expect(classifyDisconnect(DisconnectReason.connectionClosed)).toBe<DisconnectClass>('recover');
    expect(classifyDisconnect(DisconnectReason.unavailableService)).toBe('recover');
  });

  it.each<[string, number]>([
    ['loggedOut (401)', 401],
    ['forbidden (403)', 403],
    ['multideviceMismatch (411)', 411],
    ['badSession (500)', 500],
  ])('classifies %s as terminal', (_label, code) => {
    expect(classifyDisconnect(code)).toBe<DisconnectClass>('terminal');
  });

  it('treats 440 (connectionReplaced) as terminal — another device took over (documented decision)', () => {
    // research.md §2: "reconnect cautiously or treat as terminal per config". We choose
    // terminal to avoid a session ping-pong war with the device that replaced us.
    expect(classifyDisconnect(DisconnectReason.connectionReplaced)).toBe<DisconnectClass>(
      'terminal'
    );
  });

  it('treats undefined / unknown status codes as recover (best-effort, bounded by the policy)', () => {
    // A close with no Boom status code is typically a transport-level drop → recover.
    expect(classifyDisconnect(undefined)).toBe<DisconnectClass>('recover');
    expect(classifyDisconnect(9999)).toBe('recover');
  });
});
