// PURE: map a thrown delete/revoke error to a DeleteOutcome failure reason (US5, FR-028).
//
// Deletion is best-effort: the Gateway revokes via `sock.sendMessage(jid, { delete: key })` (the
// documented Baileys pattern) and, on any throw, must report a clear, NON-FATAL reason and
// continue — never throw.
//
// VERIFIED against the installed @whiskeysockets/baileys@7.0.0-rc13 source (FR-031): a revoke is
// FIRE-AND-FORGET. `relayMessage` ends at `await sendNode(stanza)` → `sendRawMessage`, a bare
// WebSocket write (`lib/Socket/socket.js`); unlike `query()` it NEVER awaits a server ack
// (`waitForMessage`). So a server-side rejection — revoke-window elapsed, message already gone,
// insufficient privilege — is never thrown; it fails silently server-side. A grep of `lib/`
// confirms no thrown error in the send path contains "window"/"expired"/"too old"/"not found"/
// "no such"/"does not exist". The ONLY errors reaching the catch are transport / precondition
// Boom errors: 428 Connection Closed, 408 Timed Out, 503 unavailable (transient → `network`),
// and 500 "All encryptions failed" / 401 "Not authenticated" (faults → `unknown`).
//
// Consequence: this classifier returns only `network` or `unknown`. The `window-expired` /
// `not-found` reasons in DeleteOutcome are RESERVED and not produced (see types.ts). And a
// successful `{ ok: true }` means the revoke stanza was SENT, not that WhatsApp confirmed it.
import type { DeleteOutcome } from '../types.js';

/** The failure half of {@link DeleteOutcome} (the `ok: false` branch). */
export type DeleteFailure = Extract<DeleteOutcome, { ok: false }>;

/** Human-readable detail extracted from an arbitrary thrown value. */
function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  const named = error as { message?: unknown } | null | undefined;
  if (named && typeof named.message === 'string') {
    return named.message;
  }
  return String(error);
}

/** Boom/HTTP-style status code, if the error carries one. */
function statusCodeOf(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | null | undefined)?.output?.statusCode;
}

/**
 * Classify a revoke failure into a {@link DeleteOutcome} reason + detail. Transport drops
 * (connection closed / timed out / unavailable) are `network`; everything else — including
 * encryption faults (`500 "All encryptions failed"`) and precondition errors
 * (`401 "Not authenticated"`) — is `unknown`, with the raw detail preserved for logging.
 */
export function classifyDeleteError(error: unknown): {
  reason: DeleteFailure['reason'];
  detail: string;
} {
  const detail = errorDetail(error);
  const statusCode = statusCodeOf(error);

  // Transient transport failures Baileys surfaces with a Boom status code.
  switch (statusCode) {
    case 408: // timedOut
    case 428: // connectionClosed
    case 503: // unavailableService
      return { reason: 'network', detail };
  }

  // Status-less raw transport errors (e.g. a socket-layer Error without a Boom wrapper).
  const haystack = detail.toLowerCase();
  if (
    haystack.includes('connection') ||
    haystack.includes('timed out') ||
    haystack.includes('timeout') ||
    haystack.includes('socket') ||
    haystack.includes('econn') ||
    haystack.includes('epipe')
  ) {
    return { reason: 'network', detail };
  }

  // Anything else: encryption faults, auth/precondition errors, and — since a revoke is
  // fire-and-forget — any server-side rejection that somehow surfaced. We do not fabricate a
  // `window-expired`/`not-found` outcome we cannot actually observe.
  return { reason: 'unknown', detail };
}
