import { describe, it, expect } from 'vitest';
import {
  nextBackoffDelayMs,
  hasExceededRestartHandshakes,
  hasExceededRecoverAttempts,
} from '#src/whatsapp-gateway/connection/reconnect-policy.js';
import type { ReconnectPolicyConfig } from '#src/whatsapp-gateway/types.js';

const NO_JITTER: ReconnectPolicyConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitter: false,
  maxAttempts: null,
};

const JITTER: ReconnectPolicyConfig = { ...NO_JITTER, jitter: true };

describe('nextBackoffDelayMs — bounded, exponential, capped (FR-011)', () => {
  it('grows exponentially from baseDelayMs (attempt 1 = base)', () => {
    expect(nextBackoffDelayMs(1, NO_JITTER)).toBe(1000);
    expect(nextBackoffDelayMs(2, NO_JITTER)).toBe(2000);
    expect(nextBackoffDelayMs(3, NO_JITTER)).toBe(4000);
    expect(nextBackoffDelayMs(4, NO_JITTER)).toBe(8000);
  });

  it('caps at maxDelayMs for large attempts', () => {
    expect(nextBackoffDelayMs(100, NO_JITTER)).toBe(30000);
    expect(nextBackoffDelayMs(50, NO_JITTER)).toBeLessThanOrEqual(30000);
  });

  it('never returns less than the first attempt for attempt <= 1 (defensive)', () => {
    expect(nextBackoffDelayMs(0, NO_JITTER)).toBe(1000);
    expect(nextBackoffDelayMs(-5, NO_JITTER)).toBe(1000);
  });

  it('with jitter, stays within [cap/2, cap] for the given attempt (rng-injected for determinism)', () => {
    // rng() = 0 → lower bound; rng() = ~1 → upper bound (the un-jittered capped value).
    expect(nextBackoffDelayMs(3, JITTER, () => 0)).toBe(2000); // 4000 / 2
    expect(nextBackoffDelayMs(3, JITTER, () => 1)).toBe(4000); // full
    const mid = nextBackoffDelayMs(3, JITTER, () => 0.5);
    expect(mid).toBeGreaterThanOrEqual(2000);
    expect(mid).toBeLessThanOrEqual(4000);
  });

  it('jitter still respects the cap', () => {
    expect(nextBackoffDelayMs(100, JITTER, () => 1)).toBe(30000);
    expect(nextBackoffDelayMs(100, JITTER, () => 0)).toBe(15000); // 30000 / 2
  });
});

describe('hasExceededRestartHandshakes — bounds the 515 loop (FR-010)', () => {
  it('is false up to and including the max, true beyond it', () => {
    expect(hasExceededRestartHandshakes(5, 5)).toBe(false);
    expect(hasExceededRestartHandshakes(6, 5)).toBe(true);
    expect(hasExceededRestartHandshakes(0, 5)).toBe(false);
  });
});

describe('hasExceededRecoverAttempts — honours maxAttempts (FR-011)', () => {
  it('never exceeds when maxAttempts is null (retry indefinitely)', () => {
    expect(hasExceededRecoverAttempts(1000, null)).toBe(false);
  });

  it('exceeds once the attempt count passes the cap', () => {
    expect(hasExceededRecoverAttempts(3, 3)).toBe(false);
    expect(hasExceededRecoverAttempts(4, 3)).toBe(true);
  });
});
