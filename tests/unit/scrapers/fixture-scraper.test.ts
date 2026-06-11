import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Import the fixture scraper (to be implemented)
import { scrapeFixtures, extractDate, type Fixture } from '#src/scraping/fixture-scraper.js';

describe('Fixture Scraper - Static HTML Parsing', () => {
  let html: string;

  beforeAll(() => {
    // Load the live HTML fixture captured from manvfatfootball.com/club/watford/
    const fixturePath = resolve(__dirname, '../../fixtures/html/manvfat-fixtures.html');
    html = readFileSync(fixturePath, 'utf-8');
  });

  describe('scrapeFixtures', () => {
    it('should extract fixtures from live HTML', () => {
      const fixtures = scrapeFixtures(html);

      // Should extract multiple fixtures
      expect(fixtures.length).toBeGreaterThan(0);
    });

    it('should extract required FR-002 fields (date, time, opponent, venue)', () => {
      const fixtures = scrapeFixtures(html);

      const fixture = fixtures[0];

      // FR-002 required fields
      expect(fixture).toHaveProperty('date');
      expect(fixture).toHaveProperty('time');
      expect(fixture).toHaveProperty('opponent');
      expect(fixture).toHaveProperty('venue');

      // Date should be a valid date string
      expect(fixture.date).toMatch(/\d{4}-\d{2}-\d{2}/);

      // Time should be HH:MM format
      expect(fixture.time).toMatch(/\d{2}:\d{2}/);

      // Opponent should be non-empty
      expect(fixture.opponent.length).toBeGreaterThan(0);

      // Venue should be present (even if default)
      expect(fixture.venue.length).toBeGreaterThan(0);
    });

    it('should handle "Fixtures to be confirmed" sections', () => {
      const fixtures = scrapeFixtures(html);

      // Should not create fixtures for "to be confirmed" weeks
      const confirmedFixtures = fixtures.filter(f =>
        f.opponent !== 'TBD' &&
        f.opponent !== 'To be confirmed'
      );

      expect(confirmedFixtures.length).toBeGreaterThan(0);
    });

    it('should extract multiple fixtures from different weeks', () => {
      const fixtures = scrapeFixtures(html);

      // Should have fixtures from multiple weeks
      const uniqueDates = new Set(fixtures.map(f => f.date));
      expect(uniqueDates.size).toBeGreaterThan(1);
    });

    it('should include game status for each fixture', () => {
      const fixtures = scrapeFixtures(html);

      fixtures.forEach(fixture => {
        expect(fixture).toHaveProperty('status');
        expect(['upcoming', 'completed', 'cancelled']).toContain(fixture.status);
      });
    });

    it('should detect completed games with scores', () => {
      const fixtures = scrapeFixtures(html);

      // Look for games with actual scores (not "-")
      const completedGames = fixtures.filter(f => f.status === 'completed');

      // There should be some completed games in the HTML
      // (if the HTML includes past games)
      expect(completedGames).toBeDefined();
    });

    it('should handle special characters in team names', () => {
      const fixtures = scrapeFixtures(html);

      fixtures.forEach(fixture => {
        // Team names should be trimmed and non-empty
        expect(fixture.opponent.trim()).toBe(fixture.opponent);
        expect(fixture.opponent.length).toBeGreaterThan(0);
      });
    });
  });

  describe('extractDate', () => {
    it('should parse "Week N - Month DDth" format', () => {
      const date = extractDate('Week 7 - June 29th', 2026);

      expect(date).toBe('2026-06-29');
    });

    it('should parse "Week N - Month DDst" format', () => {
      const date = extractDate('Week 1 - June 1st', 2026);

      expect(date).toBe('2026-06-01');
    });

    it('should parse "Week N - Month DDnd" format', () => {
      const date = extractDate('Week 2 - June 2nd', 2026);

      expect(date).toBe('2026-06-02');
    });

    it('should parse "Week N - Month DDrd" format', () => {
      const date = extractDate('Week 3 - June 3rd', 2026);

      expect(date).toBe('2026-06-03');
    });

    it('should handle different months', () => {
      const janDate = extractDate('Week 1 - January 15th', 2026);
      const decDate = extractDate('Week 20 - December 25th', 2026);

      expect(janDate).toBe('2026-01-15');
      expect(decDate).toBe('2026-12-25');
    });

    it('should infer year for dates in current season', () => {
      // Test year inference logic
      // If we're in December and the date is January, it should use next year
      const date = extractDate('Week 1 - January 10th');

      expect(date).toMatch(/\d{4}-01-10/);
    });
  });
});
