import { describe, it, expect } from 'vitest';
import {
  formatPollQuestion,
  getPollOptions,
  buildPollSpec,
} from '#src/whatsapp/poll-presenter.js';
import type { Game } from '#src/types/entities.js';

/** Pure poll-presenter tests (T023) — formatting only, no WhatsApp / DB coupling. */
describe('poll-presenter', () => {
  const game: Game = {
    id: 1,
    seasonId: 1,
    gameDate: new Date(2026, 5, 22, 19, 0), // 22 June 2026, 19:00 (local)
    opponent: 'Red Devils',
    venue: 'Victoria Park',
    status: 'upcoming',
    scrapedUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe('formatPollQuestion', () => {
    it('includes the opponent and a human date, and reads as a question', () => {
      const question = formatPollQuestion(game);
      expect(question).toContain('Red Devils');
      expect(question).toContain('22');
      expect(question).toMatch(/\?$/);
    });
  });

  describe('getPollOptions', () => {
    it('returns the three availability options as a fresh array', () => {
      const options = getPollOptions();
      expect(options).toEqual(['Yes', 'No', 'Maybe']);
      // Defensive copy — mutating the result must not leak back into the module.
      options.push('Tampered');
      expect(getPollOptions()).toEqual(['Yes', 'No', 'Maybe']);
    });
  });

  describe('buildPollSpec', () => {
    it('builds a single-choice PollSpec from a fixture', () => {
      const spec = buildPollSpec(game);
      expect(spec.question).toBe(formatPollQuestion(game));
      expect(spec.options).toEqual(['Yes', 'No', 'Maybe']);
    });
  });
});
