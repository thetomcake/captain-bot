import { describe, it, expect } from 'vitest';
import { extractStats, CONFIDENCE_THRESHOLD } from '#src/stats/stat-extractor.js';

/**
 * Pure stat-extraction unit tests (T031, US3 — FR-015/FR-016/FR-018, research §6).
 *
 * The extractor is a pure function: regex pattern-matching with a 0–100 confidence score. Only
 * the fields a message actually mentions are present on the result; `confidence` reflects the
 * strongest matched signal, reduced by uncertainty markers. The ≥70% capture decision is the
 * caller's (stat-service) — but the threshold value is asserted here so both sides agree.
 */
describe('extractStats', () => {
  it('exposes the 70% capture threshold (FR-018)', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(70);
  });

  it('captures a full stat line: "2 goals, 1 assist, weight down, tracked food"', () => {
    const r = extractStats('2 goals, 1 assist, weight down, tracked food');
    expect(r.goals).toBe(2);
    expect(r.assists).toBe(1);
    expect(r.weightDirection).toBe('down');
    expect(r.foodTracking).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(r.rawText).toBe('2 goals, 1 assist, weight down, tracked food');
  });

  it('reads a bare "scored today" as 1 goal above threshold (FR-016)', () => {
    const r = extractStats('scored today');
    expect(r.goals).toBe(1);
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    // Only goals were mentioned — nothing else is invented.
    expect(r.assists).toBeUndefined();
    expect(r.weightDirection).toBeUndefined();
    expect(r.foodTracking).toBeUndefined();
  });

  it('does not over-interpret casual chat: "great game everyone" scores below threshold', () => {
    const r = extractStats('great game everyone');
    expect(r.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(r.goals).toBeUndefined();
    expect(r.assists).toBeUndefined();
    expect(r.weightDirection).toBeUndefined();
    expect(r.foodTracking).toBeUndefined();
  });

  it('drops below threshold when uncertainty markers are present (FR-018)', () => {
    expect(extractStats('i think i scored 2 goals').confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(extractStats('maybe got 1 assist').confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(extractStats('probably 2 goals').confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('captures explicit numeric goals and assists', () => {
    const r = extractStats('2 goals, 2 assists');
    expect(r.goals).toBe(2);
    expect(r.assists).toBe(2);
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('captures an explicit single-field correction: "correction 1 goal"', () => {
    const r = extractStats('correction 1 goal');
    expect(r.goals).toBe(1);
    expect(r.assists).toBeUndefined();
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('captures weight direction up/down/same only — never values (FR-021)', () => {
    expect(extractStats('weight up').weightDirection).toBe('up');
    expect(extractStats('weight down').weightDirection).toBe('down');
    expect(extractStats('weight same').weightDirection).toBe('same');
    // No numeric weight / BMI leaks onto the result.
    const r = extractStats('weight down 2kg');
    expect(r.weightDirection).toBe('down');
    expect(r).not.toHaveProperty('weightKg');
  });

  it('captures food tracking yes/no (FR-015)', () => {
    expect(extractStats('tracked food').foodTracking).toBe(true);
    expect(extractStats("didn't track food").foodTracking).toBe(false);
  });

  it('returns confidence 0 and no fields for empty/non-stat text', () => {
    const r = extractStats('');
    expect(r.confidence).toBe(0);
    expect(r.goals).toBeUndefined();
  });
});
