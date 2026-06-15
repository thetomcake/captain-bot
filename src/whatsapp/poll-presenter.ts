/**
 * Pure poll presentation (T026) — builds the availability poll's question and options from a
 * fixture. De-Baileyed from the deleted `poll-manager.ts`: no WhatsApp client, no Gateway, no DB.
 * The Gateway port's {@link PollSpec} is the only WhatsApp-facing shape it touches.
 */
import type { Game } from '../types/entities.js';
import type { PollSpec } from './gateway-port.js';

/** Single-choice availability options, in display order. */
const POLL_OPTIONS = ['Yes', 'No', 'Maybe'] as const;

/** Format the poll question for a fixture, e.g. `Available vs Red Devils (Sun, 22 Jun)?`. */
export function formatPollQuestion(game: Game): string {
  const dateStr = game.gameDate.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return `Available vs ${game.opponent} (${dateStr})?`;
}

/** The availability options as a fresh array (callers may not mutate the module's copy). */
export function getPollOptions(): string[] {
  return [...POLL_OPTIONS];
}

/** Build the {@link PollSpec} the Gateway's `sendPoll` consumes. */
export function buildPollSpec(game: Game): PollSpec {
  return {
    question: formatPollQuestion(game),
    options: getPollOptions(),
  };
}
