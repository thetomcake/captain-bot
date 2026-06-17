import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';

import { encryptSecret, decryptSecret } from '#src/utils/crypto.js';
import { getCredentialKey } from '#src/config/env.js';
import { ConfigError } from '#src/utils/errors.js';
import type { EnvironmentConfig } from '#src/types/config.js';

// A config carrying only the credential key — getCredentialKey only reads that field.
const configWithKey = (key?: string): EnvironmentConfig =>
  ({ manvfatCredentialKey: key }) as unknown as EnvironmentConfig;

describe('crypto — AES-256-GCM encryptSecret/decryptSecret (T009 / FR-007, FR-009)', () => {
  const key = randomBytes(32);

  describe('round-trip', () => {
    it('decrypts back to the original plaintext for arbitrary strings', () => {
      const samples = [
        'hunter2',
        '',
        'p@ssw0rd with spaces & symbols: £$%^&*()',
        'unicode ✓ — émoji 🍔',
        JSON.stringify({ cookies: [{ key: 'wordpress_logged_in_x', value: 'a|b|c' }] }),
        'x'.repeat(5000),
      ];

      for (const plaintext of samples) {
        expect(decryptSecret(encryptSecret(plaintext, key), key)).toBe(plaintext);
      }
    });

    it('produces ciphertext that differs from the plaintext', () => {
      const plaintext = 'super-secret-password';
      const ciphertext = encryptSecret(plaintext, key);

      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext).not.toContain(plaintext);
    });

    it('produces a different ciphertext on each call (random IV)', () => {
      const plaintext = 'same-input-every-time';
      const a = encryptSecret(plaintext, key);
      const b = encryptSecret(plaintext, key);

      expect(a).not.toBe(b);
      // …but both still decrypt to the same plaintext.
      expect(decryptSecret(a, key)).toBe(plaintext);
      expect(decryptSecret(b, key)).toBe(plaintext);
    });

    it('stores three dot-separated base64 fields (iv.tag.ciphertext)', () => {
      const parts = encryptSecret('anything', key).split('.');
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9+/]+=*$/);
      }
    });
  });

  describe('tamper / wrong-key detection (GCM auth tag)', () => {
    it('throws when the ciphertext has been tampered with', () => {
      const [iv, tag, ct] = encryptSecret('do-not-modify', key).split('.') as [
        string,
        string,
        string,
      ];
      const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
      const tampered = [iv, tag, flipped].join('.');

      expect(() => decryptSecret(tampered, key)).toThrow();
    });

    it('throws when decrypting with the wrong key', () => {
      const ciphertext = encryptSecret('secret', key);
      const otherKey = randomBytes(32);

      expect(() => decryptSecret(ciphertext, otherKey)).toThrow();
    });

    it('throws on a malformed (non three-field) value', () => {
      expect(() => decryptSecret('not-a-valid-blob', key)).toThrow();
      expect(() => decryptSecret('only.two', key)).toThrow();
    });
  });

  describe('getCredentialKey — key sourcing/validation (FR-009)', () => {
    it('returns a 32-byte buffer for a valid base64 key', () => {
      const validKey = randomBytes(32).toString('base64');
      const resolved = getCredentialKey(configWithKey(validKey));

      expect(resolved).toHaveLength(32);
      // The resolved key actually works with the crypto primitive.
      expect(decryptSecret(encryptSecret('ok', resolved), resolved)).toBe('ok');
    });

    it('throws ConfigError when the key is missing', () => {
      expect(() => getCredentialKey(configWithKey(undefined))).toThrow(ConfigError);
    });

    it('throws ConfigError when the key does not decode to exactly 32 bytes', () => {
      const shortKey = randomBytes(16).toString('base64');
      const longKey = randomBytes(48).toString('base64');

      expect(() => getCredentialKey(configWithKey(shortKey))).toThrow(ConfigError);
      expect(() => getCredentialKey(configWithKey(longKey))).toThrow(ConfigError);
    });
  });
});
