import { describe, it, expect } from 'vitest';
import { validatePollOptions, validatePollSpec } from '#src/whatsapp-gateway/polls/poll-options.js';

describe('validatePollOptions (FR-020)', () => {
  it('accepts a valid 2-option spec', () => {
    expect(() => validatePollOptions(['Yes', 'No'])).not.toThrow();
  });

  it('accepts the maximum of 12 options', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    expect(() => validatePollOptions(twelve)).not.toThrow();
  });

  it('rejects fewer than 2 options', () => {
    expect(() => validatePollOptions(['Only one'])).toThrow();
    expect(() => validatePollOptions([])).toThrow();
  });

  it('rejects more than 12 options', () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => `Option ${i + 1}`);
    expect(() => validatePollOptions(thirteen)).toThrow();
  });

  it('rejects an empty option string', () => {
    expect(() => validatePollOptions(['Yes', ''])).toThrow();
  });

  it('rejects a whitespace-only option string', () => {
    expect(() => validatePollOptions(['Yes', '   '])).toThrow();
  });

  it('rejects a non-array input', () => {
    // Runtime guard against consumer input TypeScript cannot enforce.
    expect(() => validatePollOptions(undefined as unknown as string[])).toThrow();
  });
});

describe('validatePollSpec (FR-020)', () => {
  it('accepts a valid single-choice spec (no selectableCount on the public spec)', () => {
    expect(() =>
      validatePollSpec({ question: 'Lunch?', options: ['Pizza', 'Sushi'] })
    ).not.toThrow();
  });

  it('rejects an empty question', () => {
    expect(() => validatePollSpec({ question: '', options: ['A', 'B'] })).toThrow();
  });

  it('rejects a whitespace-only question', () => {
    expect(() => validatePollSpec({ question: '   ', options: ['A', 'B'] })).toThrow();
  });

  it('rejects an invalid options list', () => {
    expect(() => validatePollSpec({ question: 'Q?', options: ['only one'] })).toThrow();
  });
});
