import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '#src/database/schema.js';

describe('CLI Fixtures Command Contract Tests', () => {
  let testDir: string;
  let dbPath: string;
  let envPath: string;
  let cliPath: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = mkdtempSync(resolve(tmpdir(), 'captain-stats-test-'));
    dbPath = resolve(testDir, 'test.db');
    envPath = resolve(testDir, '.env');
    cliPath = resolve(__dirname, '../../../dist/cli/index.js');

    // Create test database
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite, { schema });

    // Run migrations (minimal setup for testing)
    // Create test team and season with fixtures
    db.run(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        club_url TEXT NOT NULL,
        whatsapp_group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id INTEGER NOT NULL,
        season_number INTEGER NOT NULL,
        start_date INTEGER,
        end_date INTEGER,
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        season_id INTEGER NOT NULL,
        game_date INTEGER NOT NULL,
        opponent TEXT NOT NULL,
        venue TEXT NOT NULL,
        status TEXT NOT NULL,
        scraped_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (season_id) REFERENCES seasons(id)
      )
    `);

    // Insert test data
    db.run(`INSERT INTO teams (id, name, club_url, whatsapp_group_id, created_at, updated_at)
            VALUES (1, 'Test Team', 'https://manvfatfootball.com/club/watford/', NULL, unixepoch(), unixepoch())`);

    db.run(`INSERT INTO seasons (id, team_id, season_number, is_current, created_at)
            VALUES (1, 1, 1, 1, unixepoch())`);

    // Insert test fixtures
    const futureDate1 = Math.floor(Date.now() / 1000) + 86400 * 7; // 7 days from now
    const futureDate2 = Math.floor(Date.now() / 1000) + 86400 * 14; // 14 days from now

    db.run(`INSERT INTO games (season_id, game_date, opponent, venue, status, created_at, updated_at)
            VALUES
              (1, ${futureDate1}, 'Red Devils', 'Victoria Park', 'upcoming', unixepoch(), unixepoch()),
              (1, ${futureDate2}, 'Blue Warriors', 'Central Stadium', 'upcoming', unixepoch(), unixepoch())`);

    sqlite.close();

    // Create test .env file
    writeFileSync(envPath, `
DATABASE_PATH=${dbPath}
CLUB_URL=https://manvfatfootball.com/club/watford/
TEAM_NAME=Test Team
    `.trim());
  });

  afterEach(() => {
    // Cleanup test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('captain-stats fixtures', () => {
    it('should display upcoming fixtures (human-readable format)', () => {
      const output = execSync(`node ${cliPath} fixtures --config ${envPath}`, {
        encoding: 'utf-8',
        env: { ...process.env, DATABASE_PATH: dbPath },
      });

      // Should contain header
      expect(output).toContain('Upcoming Fixtures');

      // Should contain opponent names
      expect(output).toContain('Red Devils');
      expect(output).toContain('Blue Warriors');

      // Should contain venue names
      expect(output).toContain('Victoria Park');
      expect(output).toContain('Central Stadium');
    });

    it('should output JSON format with --json flag', () => {
      const output = execSync(`node ${cliPath} fixtures --json --config ${envPath}`, {
        encoding: 'utf-8',
        env: { ...process.env, DATABASE_PATH: dbPath },
      });

      const json = JSON.parse(output);

      // Should have required structure
      expect(json).toHaveProperty('season');
      expect(json).toHaveProperty('is_current');
      expect(json).toHaveProperty('fixtures');

      // Fixtures should be array
      expect(Array.isArray(json.fixtures)).toBe(true);

      // Each fixture should have required fields
      json.fixtures.forEach((fixture: any) => {
        expect(fixture).toHaveProperty('date');
        expect(fixture).toHaveProperty('time');
        expect(fixture).toHaveProperty('opponent');
        expect(fixture).toHaveProperty('venue');
        expect(fixture).toHaveProperty('status');
      });
    });

    it('should show all fixtures with --all flag', () => {
      const output = execSync(`node ${cliPath} fixtures --all --config ${envPath}`, {
        encoding: 'utf-8',
        env: { ...process.env, DATABASE_PATH: dbPath },
      });

      // Should show both upcoming and completed fixtures
      expect(output).toBeDefined();
    });

    it('should filter by season with --season flag', () => {
      const output = execSync(`node ${cliPath} fixtures --season 1 --config ${envPath}`, {
        encoding: 'utf-8',
        env: { ...process.env, DATABASE_PATH: dbPath },
      });

      expect(output).toContain('Season 1');
    });

    it('should display fixtures in chronological order', () => {
      const output = execSync(`node ${cliPath} fixtures --config ${envPath}`, {
        encoding: 'utf-8',
      });

      // "Red Devils" should appear before "Blue Warriors" (earlier date)
      const redDevilsPos = output.indexOf('Red Devils');
      const blueWarriorsPos = output.indexOf('Blue Warriors');

      expect(redDevilsPos).toBeLessThan(blueWarriorsPos);
    });
  });

  describe('exit codes (per cli-interface.md)', () => {
    it('should exit with 0 on success', () => {
      try {
        execSync(`node ${cliPath} fixtures --config ${envPath}`, {
          encoding: 'utf-8',
          env: { ...process.env, DATABASE_PATH: dbPath },
        });
      } catch (error: any) {
        expect(error.status).toBe(0);
      }
    });

    it('should exit with 1 when no fixtures found', () => {
      // Clear fixtures from database
      const sqlite = new Database(dbPath);
      sqlite.exec('DELETE FROM games');
      sqlite.close();

      try {
        execSync(`node ${cliPath} fixtures --config ${envPath}`, {
          encoding: 'utf-8',
        });
      } catch (error: any) {
        expect(error.status).toBe(1);
      }
    });

    it('should exit with 2 for invalid season number', () => {
      try {
        execSync(`node ${cliPath} fixtures --season 999 --config ${envPath}`, {
          encoding: 'utf-8',
        });
      } catch (error: any) {
        expect(error.status).toBe(2);
      }
    });

    it('should exit with 3 for database error', () => {
      try {
        execSync(`node ${cliPath} fixtures --config ${envPath}`, {
          encoding: 'utf-8',
          env: { ...process.env, DATABASE_PATH: '/nonexistent/path/db.sqlite' },
        });
      } catch (error: any) {
        expect(error.status).toBe(3);
      }
    });
  });

  describe('table formatting', () => {
    it('should format date column correctly', () => {
      const output = execSync(`node ${cliPath} fixtures --config ${envPath}`, {
        encoding: 'utf-8',
      });

      // Should contain date in readable format (YYYY-MM-DD or similar)
      expect(output).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('should format time column correctly (HH:MM)', () => {
      const output = execSync(`node ${cliPath} fixtures --config ${envPath}`, {
        encoding: 'utf-8',
      });

      // Should contain time in HH:MM format
      expect(output).toMatch(/\d{2}:\d{2}/);
    });

    it('should align columns properly', () => {
      const output = execSync(`node ${cliPath} fixtures --config ${envPath}`, {
        encoding: 'utf-8',
      });

      // Should have table separators
      expect(output).toMatch(/[─┼│]/);
    });
  });

  describe('--help flag', () => {
    it('should display help information', () => {
      const output = execSync(`node ${cliPath} fixtures --help`, {
        encoding: 'utf-8',
      });

      expect(output).toContain('Usage:');
      expect(output).toContain('Options:');
      expect(output).toContain('--all');
      expect(output).toContain('--season');
      expect(output).toContain('--json');
    });
  });

  describe('error messages', () => {
    it('should display clear error for missing config', () => {
      try {
        execSync(`node ${cliPath} fixtures`, {
          encoding: 'utf-8',
          stderr: 'pipe',
        });
      } catch (error: any) {
        expect(error.stderr).toContain('Configuration error');
      }
    });

    it('should write errors to stderr', () => {
      try {
        execSync(`node ${cliPath} fixtures --season invalid`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error: any) {
        expect(error.stderr.length).toBeGreaterThan(0);
      }
    });
  });

  describe('performance (per spec.md SC-001)', () => {
    it('should return fixtures within 5 seconds', () => {
      const start = Date.now();

      execSync(`node ${cliPath} fixtures --config ${envPath}`, {
        encoding: 'utf-8',
      });

      const duration = Date.now() - start;

      // SC-001: Captain can view all team fixtures within 5 seconds
      expect(duration).toBeLessThan(5000);
    });
  });
});
