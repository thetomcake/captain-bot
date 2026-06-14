// PURE: the reconnect schedule — bounded, exponential, jittered backoff plus the two
// retry caps (FR-010/FR-011). All functions are deterministic given their inputs (the
// jitter source is injectable), so they are fully unit-tested (reconnect-policy.test.ts).
//
// The connection-state reducer (T020a) uses the cap helpers to decide restart vs terminal;
// the gateway shell (T023) uses `nextBackoffDelayMs` to schedule a recover reconnect.
import type { ReconnectPolicyConfig } from '../types.js';

/**
 * Delay before the Nth recover reconnect attempt (1-based). Grows as
 * `baseDelayMs * factor^(attempt-1)`, capped at `maxDelayMs`. When `policy.jitter`
 * is set, the result is spread across `[cap/2, cap]` ("equal jitter") so a fleet of
 * clients doesn't reconnect in lockstep.
 *
 * @param attempt 1-based attempt number (values < 1 are treated as 1).
 * @param rng injectable source of randomness in `[0, 1)`; defaults to `Math.random`
 *            (injected in tests for determinism).
 */
export function nextBackoffDelayMs(
  attempt: number,
  policy: ReconnectPolicyConfig,
  rng: () => number = Math.random
): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = policy.baseDelayMs * Math.pow(policy.factor, n - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  if (!policy.jitter) {
    return capped;
  }
  // Equal jitter: half fixed, half random — keeps the delay within [cap/2, cap].
  return capped / 2 + (capped / 2) * rng();
}

/**
 * True once the number of consecutive post-pairing 515 handshakes has passed the cap
 * (FR-010). A stuck handshake loop then fails loudly as terminal instead of spinning.
 */
export function hasExceededRestartHandshakes(
  handshakeCount: number,
  maxRestartHandshakes: number
): boolean {
  return handshakeCount > maxRestartHandshakes;
}

/**
 * True once recover reconnect attempts have passed the cap (FR-011). `null` ⇒ retry
 * recoverable closes indefinitely (the default), so this never returns true.
 */
export function hasExceededRecoverAttempts(attempt: number, maxAttempts: number | null): boolean {
  if (maxAttempts === null) {
    return false;
  }
  return attempt > maxAttempts;
}
