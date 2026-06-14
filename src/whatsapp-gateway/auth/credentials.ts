// PURE: the SINGLE source-of-truth (de)serialization between a live Baileys auth
// state and the opaque `WhatsAppCredentials` snapshot the consumer persists (FR-006/FR-008).
//
// There is exactly ONE implementation of this conversion in the library — it is used by
// both the auth store (auth-state.ts, T022) and, transitively, the gateway (T023). The
// first attempt shipped a dead second copy that always emitted `keys: {}`; do not
// reintroduce one. `serializeAuthState` always reflects the *live* creds + key map it is
// handed; it never fabricates or drops keys.
//
// Serialization uses Baileys' `BufferJSON` (the documented mechanism) so every `Buffer` /
// `Uint8Array` survives a round-trip, and reconstructs the one key type that needs a proto
// wrapper on the way back (`app-state-sync-key`) — mirroring the documented auth-state
// pattern. Round-trip equivalence is unit-tested in credentials.test.ts.
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { WhatsAppCredentials } from '../types.js';

/**
 * The plain, JSON-friendly shape of the signal key store: `{ [type]: { [id]: value } }`.
 * (The live store wraps this with get/set methods; the snapshot stores the data only.)
 */
export type SignalKeyDataMap = {
  [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] };
};

/** The full auth material: long-lived creds + the signal key data. */
export interface AuthSnapshotData {
  creds: AuthenticationCreds;
  keys: SignalKeyDataMap;
}

/** Serialize live creds + keys into the opaque snapshot. Reflects exactly what it is given. */
export function serializeAuthState(data: AuthSnapshotData): WhatsAppCredentials {
  return JSON.stringify({ creds: data.creds, keys: data.keys }, BufferJSON.replacer);
}

/**
 * Parse an opaque snapshot back into live auth material. Buffers are restored by
 * `BufferJSON.reviver`; `app-state-sync-key` values are re-wrapped in their proto type
 * (Baileys hands them out as proto objects, so the store must too).
 */
export function deserializeAuthState(snapshot: WhatsAppCredentials): AuthSnapshotData {
  const parsed = JSON.parse(snapshot, BufferJSON.reviver) as {
    creds?: AuthenticationCreds;
    keys?: SignalKeyDataMap;
  };

  const keys: SignalKeyDataMap = parsed.keys ?? {};

  const appStateKeys = keys['app-state-sync-key'];
  if (appStateKeys) {
    for (const id of Object.keys(appStateKeys)) {
      const value = appStateKeys[id];
      if (value) {
        appStateKeys[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
    }
  }

  // A missing/blank creds block means a fresh session (matches initAuthCreds()).
  return { creds: parsed.creds ?? initAuthCreds(), keys };
}
