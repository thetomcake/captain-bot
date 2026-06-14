// PURE: map a Baileys close status code → recover | terminal | restart (research.md §2).
//
// This is the only place the raw Baileys status codes are interpreted. It is a pure
// function of the status code so it is fully unit-tested (disconnect-classifier.test.ts);
// the socket-bound shell (gateway.ts) only forwards `lastDisconnect.error.output.statusCode`.
//
// NOTE on intentional closes: operator-initiated closes (`disconnect()` / `forceReauth()`)
// are handled upstream by the connection-state reducer's intentional-close flag (T020a) and
// never reach this classifier — so we never need a "was this on purpose?" input here.
import { DisconnectReason } from '@whiskeysockets/baileys';

/** What the gateway should do in response to a close (drives the reducer, T020a). */
export type DisconnectClass = 'restart' | 'recover' | 'terminal';

/**
 * Classify a WhatsApp disconnect by its Baileys status code.
 *
 * - `restart`  → `515` (restartRequired): the expected post-pairing handshake; reconnect
 *   immediately with the same in-memory creds (bounded by `maxRestartHandshakes`).
 * - `recover`  → `408` (connectionLost/timedOut — ambiguous, always recover), `428`
 *   (connectionClosed), `503` (unavailableService), and any unknown/undefined code
 *   (typically a transport-level drop): reconnect on a bounded backoff.
 * - `terminal` → `401` (loggedOut), `403` (forbidden), `411` (multideviceMismatch),
 *   `500` (badSession): stop and surface; the session is dead and may need re-auth.
 *
 * Documented decision — `440` (connectionReplaced): another device took over this
 * session. research.md §2 allows "reconnect cautiously or treat as terminal per config";
 * we choose **terminal** so we do not start a session ping-pong war with the device that
 * replaced us. (A consumer that wants to reclaim the session can call `connect()` again.)
 *
 * Documented decision — `undefined` / unknown code: a close with no Boom status code is
 * almost always a network-level drop, so we default to **recover** (bounded by the policy)
 * rather than giving up. A genuinely fatal unknown code will simply fail to reconnect.
 */
export function classifyDisconnect(statusCode: number | undefined): DisconnectClass {
  switch (statusCode) {
    case DisconnectReason.restartRequired: // 515
      return 'restart';

    case DisconnectReason.loggedOut: // 401
    case DisconnectReason.forbidden: // 403
    case DisconnectReason.multideviceMismatch: // 411
    case DisconnectReason.badSession: // 500
    case DisconnectReason.connectionReplaced: // 440 — see decision above
      return 'terminal';

    case DisconnectReason.connectionLost: // 408 (also timedOut, same code)
    case DisconnectReason.connectionClosed: // 428
    case DisconnectReason.unavailableService: // 503
      return 'recover';

    default:
      // undefined / unknown → best-effort recover (research.md §2 decision).
      return 'recover';
  }
}
