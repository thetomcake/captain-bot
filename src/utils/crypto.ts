/**
 * Symmetric encryption for secrets at rest (feature 005).
 *
 * AES-256-GCM with a random 12-byte IV per encryption. The stored format is
 * `base64(iv).base64(tag).base64(ciphertext)` — three dot-separated base64 fields.
 * GCM gives authenticated encryption, so a tampered/corrupted ciphertext (or the
 * wrong key) fails the auth-tag check on decrypt and throws.
 *
 * This is a pure crypto primitive: the caller supplies the 32-byte key (sourced and
 * validated by the config layer — see `getCredentialKey` in `src/config/env.ts`). The
 * algorithm, IV size, and stored format are invariants of the scheme and intentionally
 * live here, not in config — changing any of them would make existing ciphertext
 * undecryptable.
 *
 * Secrets and the key never touch the logger — callers must keep it that way.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce — the standard/recommended size for GCM

/**
 * Encrypt a UTF-8 plaintext string. Returns `base64(iv).base64(tag).base64(ct)`.
 * Each call uses a fresh random IV, so encrypting the same plaintext twice yields
 * different ciphertexts.
 * @param key 32-byte AES-256 key (see `getCredentialKey`).
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/**
 * Decrypt a value produced by {@link encryptSecret} back to its UTF-8 plaintext.
 * @param key the same 32-byte key used to encrypt.
 * @throws {Error} if the input is not in the expected three-field format, or if the
 *   GCM auth-tag check fails (tampered/corrupted ciphertext or wrong key).
 */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error(
      'Malformed encrypted value: expected base64(iv).base64(tag).base64(ciphertext)'
    );
  }

  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}
