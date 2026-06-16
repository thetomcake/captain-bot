/**
 * Pure poll presentation (T026) — builds the availability poll's question and options from a
 * fixture. De-Baileyed from the deleted `poll-manager.ts`: no WhatsApp client, no Gateway, no DB.
 * The Gateway port's {@link PollSpec} is the only WhatsApp-facing shape it touches.
 */
import type { Game } from '../types/entities.js';
import type { PollSpec } from './gateway-port.js';

/** Single-choice availability options, in display order. */
const POLL_OPTIONS = ['Yes', 'No', 'Maybe'] as const;

/** Format the poll question for a fixture, e.g. `Mon 22 Jun - 7PM vs Red Devils`. */
export function formatPollQuestion(game: Game): string {
  const dateStr = game.gameDate
    .toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })
    .replace(/,/g, '');
  return `${dateStr} - ${formatKickoffTime(game.gameDate)} vs ${game.opponent}`;
}

/** Kickoff time in 12-hour form with no leading zero, e.g. `7PM` or `7:30PM`. */
function formatKickoffTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const mins = minutes === 0 ? '' : `:${minutes.toString().padStart(2, '0')}`;
  return `${hour12}${mins}${period}`;
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
