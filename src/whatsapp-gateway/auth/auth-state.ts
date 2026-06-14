// The in-memory auth store (T022): builds a live Baileys `AuthenticationState` from an
// opaque snapshot (or a fresh one) and is the single funnel for persisting credential
// changes back to the consumer (FR-006/FR-008/FR-012). It touches NO disk or DB — the
// consumer persists the opaque snapshot via `onCredentialsUpdate` / `getCredentials()`.
//
// Lifecycle discipline (the bugs that broke the first attempt):
//   • C-1 — there is exactly ONE place that pushes `onCredentialsUpdate`: `emitUpdate()`.
//     Both a signal-key write and the gateway's `creds.update` handler funnel through it,
//     and it always serializes the LIVE creds+keys (never a stale constructor snapshot).
//   • C-2 — the store is built ONCE per session and reused across socket re-creation
//     (the 515 handshake and every recover reconnect). Only `clear()` (forced re-auth)
//     replaces the in-memory state. The gateway must NOT rebuild this on a reconnect.
import { initAuthCreds, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalKeyStore,
} from '@whiskeysockets/baileys';
import type { Logger, WhatsAppCredentials } from '../types.js';
import { serializeAuthState, deserializeAuthState, type SignalKeyDataMap } from './credentials.js';

export interface AuthStore {
  /** The live Baileys auth state to hand to `makeWASocket({ auth })`. */
  readonly state: AuthenticationState;
  /** Current live snapshot (creds + keys). Used by `getCredentials()`; does NOT emit. */
  serialize(): WhatsAppCredentials;
  /** The single credential-update funnel (C-1). Called on a key write and on `creds.update`. */
  emitUpdate(): void;
  /** Forced re-auth (FR-007): drop all in-memory creds + keys so the next connect QR-pairs. */
  clear(): void;
}

export interface AuthStoreOptions {
  /** Opaque snapshot to resume from; omit ⇒ a fresh session (QR pairing). */
  credentials?: WhatsAppCredentials;
  /** Consumer persistence callback; invoked (once per change) via `emitUpdate()`. */
  onCredentialsUpdate?: (creds: WhatsAppCredentials) => void | Promise<void>;
  logger: Logger;
}

/**
 * Build the one-per-session in-memory auth store. Holds the creds object (which Baileys
 * mutates in place on `creds.update`) and a plain key-data map behind a cacheable
 * `SignalKeyStore`. Every key write triggers the single `emitUpdate()` funnel.
 */
export function createAuthStore(options: AuthStoreOptions): AuthStore {
  const { onCredentialsUpdate, logger } = options;

  let creds: AuthenticationCreds;
  let keyData: SignalKeyDataMap;

  if (options.credentials) {
    const restored = deserializeAuthState(options.credentials);
    creds = restored.creds;
    keyData = restored.keys;
  } else {
    creds = initAuthCreds();
    keyData = {};
  }

  // The SINGLE place credentials are pushed to the consumer (C-1). Always serializes the
  // live creds + key map; never throws into the caller (a bad handler must not kill the socket).
  function emitUpdate(): void {
    if (!onCredentialsUpdate) {
      return;
    }
    let snapshot: WhatsAppCredentials;
    try {
      snapshot = serializeAuthState({ creds, keys: keyData });
    } catch (err) {
      logger.error('WhatsAppGateway: failed to serialize credentials', err);
      return;
    }
    try {
      const result = onCredentialsUpdate(snapshot);
      if (result instanceof Promise) {
        result.catch((err) => logger.error('WhatsAppGateway: onCredentialsUpdate rejected', err));
      }
    } catch (err) {
      logger.error('WhatsAppGateway: onCredentialsUpdate threw', err);
    }
  }

  // The raw in-memory signal key store over `keyData`. Mirrors the documented auth-state
  // shape (get/set/clear); a key write funnels through the single update emitter.
  const rawStore: SignalKeyStore = {
    get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const category = keyData[type] as Record<string, SignalDataTypeMap[T]> | undefined;
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const value = category?.[id];
        if (value !== undefined) {
          result[id] = value;
        }
      }
      return result;
    },
    set(data) {
      // `data` and `keyData` are heterogeneous per-type maps; a loose record view keeps
      // this readable without `any` while preserving the values verbatim.
      const incoming = data as Record<string, Record<string, unknown> | undefined>;
      const bag = keyData as Record<string, Record<string, unknown> | undefined>;
      let changed = false;
      for (const type of Object.keys(incoming)) {
        const categoryData = incoming[type];
        if (!categoryData) {
          continue;
        }
        let store = bag[type];
        if (!store) {
          store = {};
          bag[type] = store;
        }
        for (const id of Object.keys(categoryData)) {
          const value = categoryData[id];
          if (value === null || value === undefined) {
            delete store[id];
          } else {
            store[id] = value;
          }
          changed = true;
        }
      }
      if (changed) {
        emitUpdate();
      }
    },
    clear() {
      const bag = keyData as Record<string, unknown>;
      for (const type of Object.keys(bag)) {
        delete bag[type];
      }
    },
  };

  // The live state object the gateway hands to the socket. We rebuild `keys` on clear()
  // (to drop the cache); `creds` is the same reference Baileys mutates in place.
  const state: AuthenticationState = {
    creds,
    keys: makeCacheableSignalKeyStore(rawStore),
  };

  return {
    state,
    serialize: () => serializeAuthState({ creds, keys: keyData }),
    emitUpdate,
    clear() {
      // Forced re-auth: replace creds with a fresh set and wipe keys in place. The same
      // `state` object is reused; the gateway creates a new socket from it afterwards.
      creds = initAuthCreds();
      state.creds = creds;
      const bag = keyData as Record<string, unknown>;
      for (const type of Object.keys(bag)) {
        delete bag[type];
      }
      // Rebuild the cacheable wrapper so no stale cached keys survive the re-auth.
      state.keys = makeCacheableSignalKeyStore(rawStore);
    },
  };
}
