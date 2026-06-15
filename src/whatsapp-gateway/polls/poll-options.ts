// PURE poll-input validation (FR-020).
//
// Polls are SINGLE-CHOICE for now (multi-select is out of scope), so the public
// `PollSpec` carries only `question` + `options` — no `selectableCount`. The gateway
// always sends `selectableCount: 1`. WhatsApp's own client caps a poll at 12 options
// and rejects empty ones; Baileys does NOT enforce either (verified against the
// installed 7.0.0-rc13 `generateWAMessageContent`, which only guards
// `selectableCount` range), so we validate here before sending.
//
// This unit is pure and unit-tested in poll-options.test.ts.
import type { PollSpec } from '../types.js';

/** WhatsApp's client minimum/maximum option counts for a poll. */
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 12;

/**
 * Validate a poll's option list: a real array of {@link MIN_POLL_OPTIONS}–
 * {@link MAX_POLL_OPTIONS} entries, each a non-empty (non-whitespace) string.
 *
 * @throws Error with a clear, consumer-facing message on any violation.
 */
export function validatePollOptions(options: string[]): void {
  if (!Array.isArray(options)) {
    throw new Error('PollSpec.options must be an array of option strings (FR-020).');
  }
  if (options.length < MIN_POLL_OPTIONS || options.length > MAX_POLL_OPTIONS) {
    throw new Error(
      `PollSpec.options must contain between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} ` +
        `options (got ${options.length}) (FR-020).`
    );
  }
  options.forEach((option, index) => {
    if (typeof option !== 'string' || option.trim().length === 0) {
      throw new Error(`PollSpec.options[${index}] must be a non-empty string (FR-020).`);
    }
  });
}

/**
 * Validate a full {@link PollSpec}: a non-empty question plus a valid option list.
 *
 * @throws Error with a clear, consumer-facing message on any violation.
 */
export function validatePollSpec(spec: PollSpec): void {
  if (typeof spec?.question !== 'string' || spec.question.trim().length === 0) {
    throw new Error('PollSpec.question must be a non-empty string (FR-020).');
  }
  validatePollOptions(spec.options);
}
