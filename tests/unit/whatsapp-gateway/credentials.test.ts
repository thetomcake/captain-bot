import { describe, it, expect } from 'vitest';
import { initAuthCreds } from '@whiskeysockets/baileys';
import {
  serializeAuthState,
  deserializeAuthState,
  type AuthSnapshotData,
} from '#src/whatsapp-gateway/auth/credentials.js';

// Build a NON-EMPTY snapshot with one entry of each v7 key type that a naive
// serializer is most likely to drop, plus a Buffer-valued credential. The first
// implementation attempt serialized an empty key store and asserted nothing about
// keys — this test exists specifically to prevent that regression (tasks.md T018).
function buildSnapshot(): AuthSnapshotData {
  const creds = initAuthCreds();
  // A Buffer-valued credential (must survive byte-for-byte).
  creds.routingInfo = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

  const snapshot: AuthSnapshotData = {
    creds,
    keys: {
      'pre-key': {
        '1': {
          public: new Uint8Array([1, 2, 3, 4, 5]),
          private: new Uint8Array([6, 7, 8, 9, 10]),
        },
      },
      session: {
        'sess-id': new Uint8Array([11, 22, 33, 44, 55, 66]),
      },
      'lid-mapping': {
        '123@lid': '123456@s.whatsapp.net',
      },
      'device-list': {
        '123456@s.whatsapp.net': ['123456:0@s.whatsapp.net', '123456:1@s.whatsapp.net'],
      },
      tctoken: {
        'token-id': { token: Buffer.from([0x01, 0x02, 0x03]), senderTimestamp: 1700000000 },
      },
    },
  };
  return snapshot;
}

function bytesEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe('credentials serialize/deserialize round-trip (FR-006/FR-008)', () => {
  it('produces an opaque JSON string', () => {
    const snapshot = buildSnapshot();
    const serialized = serializeAuthState(snapshot);
    expect(typeof serialized).toBe('string');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('round-trips creds + every v7 key type and is stable on re-serialization', () => {
    const original = buildSnapshot();
    const once = serializeAuthState(original);
    const restored = deserializeAuthState(once);
    const twice = serializeAuthState(restored);
    // Re-serializing the restored state yields an identical string ⇒ nothing was dropped.
    expect(twice).toBe(once);
  });

  it('preserves the Buffer-valued credential byte-for-byte', () => {
    const restored = deserializeAuthState(serializeAuthState(buildSnapshot()));
    expect(restored.creds.routingInfo).toBeDefined();
    expect(
      bytesEqual(restored.creds.routingInfo as Buffer, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
    ).toBe(true);
  });

  it('preserves pre-key and session key material byte-for-byte', () => {
    const restored = deserializeAuthState(serializeAuthState(buildSnapshot()));
    const preKey = restored.keys['pre-key']?.['1'];
    expect(preKey).toBeDefined();
    expect(bytesEqual(preKey!.public, new Uint8Array([1, 2, 3, 4, 5]))).toBe(true);
    expect(bytesEqual(preKey!.private, new Uint8Array([6, 7, 8, 9, 10]))).toBe(true);

    const session = restored.keys.session?.['sess-id'];
    expect(session).toBeDefined();
    expect(bytesEqual(session as Uint8Array, new Uint8Array([11, 22, 33, 44, 55, 66]))).toBe(true);
  });

  it('preserves the v7-specific lid-mapping, device-list and tctoken entries', () => {
    const restored = deserializeAuthState(serializeAuthState(buildSnapshot()));

    expect(restored.keys['lid-mapping']?.['123@lid']).toBe('123456@s.whatsapp.net');

    expect(restored.keys['device-list']?.['123456@s.whatsapp.net']).toEqual([
      '123456:0@s.whatsapp.net',
      '123456:1@s.whatsapp.net',
    ]);

    const tctoken = restored.keys.tctoken?.['token-id'];
    expect(tctoken).toBeDefined();
    expect(bytesEqual(tctoken!.token, Buffer.from([0x01, 0x02, 0x03]))).toBe(true);
    expect(tctoken!.senderTimestamp).toBe(1700000000);
  });

  it('deserializes a snapshot that has no keys into an empty key map (fresh-ish session)', () => {
    const creds = initAuthCreds();
    const serialized = serializeAuthState({ creds, keys: {} });
    const restored = deserializeAuthState(serialized);
    expect(restored.keys).toEqual({});
  });
});
