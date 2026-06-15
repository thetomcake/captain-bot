/**
 * Pure stat extractor (T033, US3 — FR-015/FR-016/FR-018/FR-021, research §6).
 *
 * Regex pattern-matching with a 0–100 confidence score. No ML, no I/O, no WhatsApp coupling: it
 * maps a chat message to the stats it mentions plus a confidence the caller (stat-service) gates
 * on at {@link CONFIDENCE_THRESHOLD}. Only fields a message actually mentions appear on the
 * result, so the service can merge field-by-field (FR-019). Weight is captured as *direction*
 * only — never a value or BMI (FR-021).
 */
import type { ExtractedStats } from '../types/whatsapp.js';
import type { WeightDirection } from '../types/entities.js';

/** Capture threshold (FR-018): the service captures only when `confidence >= 70`. */
export const CONFIDENCE_THRESHOLD = 70;

/** Confidence subtracted (once) when the message hedges — "think", "maybe", "probably", … */
const UNCERTAINTY_PENALTY = 25;

const UNCERTAINTY_MARKERS = [
  'think',
  'maybe',
  'probably',
  'possibly',
  'reckon',
  'not sure',
  'unsure',
  'dunno',
  'i guess',
  'guess',
  'might have',
];

interface Pattern<T> {
  regex: RegExp;
  confidence: number;
  /** Derive the field value from the regex match. */
  value: (m: RegExpMatchArray) => T;
}

// Ordered most-specific (explicit number) first; the first match for a field wins.
const GOAL_PATTERNS: Pattern<number>[] = [
  { regex: /\bscored\s+(\d+)\b/i, confidence: 90, value: (m) => Number(m[1]) },
  { regex: /\b(\d+)\s+goals?\b/i, confidence: 90, value: (m) => Number(m[1]) },
  { regex: /\bbagged\s+(\d+)\b/i, confidence: 88, value: (m) => Number(m[1]) },
  { regex: /\bhat[\s-]?trick\b/i, confidence: 85, value: () => 3 },
  { regex: /\bbrace\b/i, confidence: 80, value: () => 2 },
  { regex: /\bscored\b/i, confidence: 80, value: () => 1 },
  { regex: /\bgot\s+(?:a|one|1)\b/i, confidence: 72, value: () => 1 },
];

const ASSIST_PATTERNS: Pattern<number>[] = [
  { regex: /\b(\d+)\s+assists?\b/i, confidence: 90, value: (m) => Number(m[1]) },
  { regex: /\bassisted\b/i, confidence: 80, value: () => 1 },
];

const WEIGHT_PATTERNS: Pattern<WeightDirection>[] = [
  { regex: /\bweight\s+(up|down|same)\b/i, confidence: 90, value: (m) => m[1]!.toLowerCase() as WeightDirection },
  { regex: /\b(?:lost|dropped)\s+weight\b/i, confidence: 85, value: () => 'down' },
  { regex: /\b(?:gained|put\s+on)\s+weight\b/i, confidence: 85, value: () => 'up' },
  { regex: /\bweight\s+(?:stayed\s+)?(?:the\s+)?same\b/i, confidence: 85, value: () => 'same' },
];

const FOOD_PATTERNS: Pattern<boolean>[] = [
  { regex: /\b(?:didn'?t|did\s+not|not|no)\b[^.!?]*\btrack(?:ed|ing)?\b/i, confidence: 85, value: () => false },
  { regex: /\bno\s+(?:food\s+)?track(?:ing)?\b/i, confidence: 85, value: () => false },
  { regex: /\btrack(?:ed|ing)?\b[^.!?]*\b(?:food|meals?|eating|macros)\b/i, confidence: 85, value: () => true },
  { regex: /\b(?:logged|tracked)\s+(?:my\s+)?(?:food|meals?|eating|macros)\b/i, confidence: 85, value: () => true },
];

/** First matching pattern for a field, or `undefined` if none match. */
function firstMatch<T>(text: string, patterns: Pattern<T>[]): { value: T; confidence: number } | undefined {
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m) return { value: p.value(m), confidence: p.confidence };
  }
  return undefined;
}

function hasUncertainty(text: string): boolean {
  const lower = text.toLowerCase();
  return UNCERTAINTY_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Extract the stats a message mentions plus an overall confidence (the strongest matched signal,
 * minus an uncertainty penalty if the message hedges). Unmentioned fields are left `undefined` so
 * the service merges only what was stated (FR-019/FR-020). No match ⇒ confidence 0.
 */
export function extractStats(text: string): ExtractedStats {
  const result: ExtractedStats = { confidence: 0, rawText: text };

  const goals = firstMatch(text, GOAL_PATTERNS);
  const assists = firstMatch(text, ASSIST_PATTERNS);
  const weight = firstMatch(text, WEIGHT_PATTERNS);
  const food = firstMatch(text, FOOD_PATTERNS);

  const confidences: number[] = [];
  if (goals) {
    result.goals = goals.value;
    confidences.push(goals.confidence);
  }
  if (assists) {
    result.assists = assists.value;
    confidences.push(assists.confidence);
  }
  if (weight) {
    result.weightDirection = weight.value;
    confidences.push(weight.confidence);
  }
  if (food) {
    result.foodTracking = food.value;
    confidences.push(food.confidence);
  }

  if (confidences.length === 0) return result; // no stat signal at all

  let confidence = Math.max(...confidences);
  if (hasUncertainty(text)) confidence -= UNCERTAINTY_PENALTY;
  result.confidence = Math.max(0, Math.min(100, confidence));
  return result;
}
