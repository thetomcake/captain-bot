import { IFixtureScraper, Fixture, scrapeFixtures } from '../../src/scraping/fixture-scraper.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Mock scraper that returns static HTML from fixture files
 * No real HTTP calls - perfect for fast integration tests
 */
export class MockFixtureScraper implements IFixtureScraper {
  private htmlContent: string;

  constructor(htmlContent?: string) {
    // Default to the live Watford fixtures HTML
    if (!htmlContent) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const fixturePath = join(__dirname, '../fixtures/html/manvfat-fixtures.html');
      this.htmlContent = readFileSync(fixturePath, 'utf-8');
    } else {
      this.htmlContent = htmlContent;
    }
  }

  async fetchHtml(_url: string): Promise<string> {
    // No HTTP call - return static HTML
    return this.htmlContent;
  }

  parseFixtures(html: string): Fixture[] {
    // Use real parser with static HTML
    return scrapeFixtures(html);
  }

  /**
   * Set custom HTML for testing different scenarios
   */
  setHtml(html: string): void {
    this.htmlContent = html;
  }
}

/**
 * Mock scraper that throws an error (for error handling tests)
 */
export class ErrorMockScraper implements IFixtureScraper {
  constructor(private errorMessage: string = 'Network error') {}

  async fetchHtml(_url: string): Promise<string> {
    throw new Error(this.errorMessage);
  }

  parseFixtures(_html: string): Fixture[] {
    return [];
  }
}
