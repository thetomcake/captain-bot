/**
 * Environment configuration loader with validation
 */

import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import type { EnvironmentConfig } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';

/**
 * Validate and parse a required environment variable
 */
function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value
 */
function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Parse integer from environment variable
 */
function parseInteger(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new ConfigError(`Environment variable ${key} must be a valid integer, got: ${value}`);
  }

  return parsed;
}

/**
 * Validate club URL format
 */
function validateClubUrl(url: string): void {
  if (!url.startsWith('https://manvfatfootball.') && !url.startsWith('http://localhost')) {
    throw new ConfigError(
      `Invalid CLUB_URL: must be a manvfatfootball.org/club/* URL, got: ${url}`
    );
  }
}

/**
 * Validate WhatsApp group JID format
 */
function validateGroupId(jid: string | undefined): void {
  if (jid && !jid.endsWith('@g.us')) {
    throw new ConfigError(
      `Invalid AUTHORIZED_GROUP_ID: must be a WhatsApp group JID (*@g.us), got: ${jid}`
    );
  }
}

/**
 * Load and validate environment configuration
 * @param configPath - Optional path to .env file (default: .env in cwd)
 */
export function loadEnvironmentConfig(configPath?: string): EnvironmentConfig {
  // Resolve config file path
  const envPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.join(process.cwd(), '.env');

  // Validate config file exists if custom path specified
  if (configPath) {
    if (!fs.existsSync(envPath)) {
      throw new ConfigError(
        `Config file not found: ${envPath}\n` +
          `Specified via --config flag. Check the path and try again.`
      );
    }

    // Check file permissions (readable)
    try {
      fs.accessSync(envPath, fs.constants.R_OK);
    } catch (error) {
      throw new ConfigError(
        `Config file exists but is not readable: ${envPath}\n` +
          `Check file permissions (should be readable by current user).`
      );
    }
  }

  // Load environment variables from specified file (quiet: true to suppress console output)
  const result = config({ path: envPath, quiet: true });

  // If default .env doesn't exist, that's okay (use system env vars)
  // But if user specified --config and it failed, throw error
  if (result.error && configPath) {
    throw new ConfigError(
      `Failed to load config file: ${envPath}\n` + `Error: ${result.error.message}`
    );
  }

  // Required fields
  const teamName = required('TEAM_NAME');
  const clubUrl = required('CLUB_URL');

  // Validate formats
  validateClubUrl(clubUrl);

  // Optional fields
  const authorizedGroupId = process.env.AUTHORIZED_GROUP_ID;
  validateGroupId(authorizedGroupId);

  // MAN v FAT portal credentials (feature 005) — surfaced for `init` seeding and the
  // scrape-time crypto. Optional at load; required only when scraping/seeding.
  const manvfatUsername = process.env.MANVFAT_USERNAME;
  const manvfatPassword = process.env.MANVFAT_PASSWORD;
  const manvfatCredentialKey = process.env.MANVFAT_CREDENTIAL_KEY;

  const databasePath = optional('DATABASE_PATH', path.join(process.cwd(), 'captain-stats.db'));

  // Stat capture window (FR-019). Scheduling knobs (POLL_POST_HOUR / FIXTURE_SYNC_INTERVAL) are
  // gone — the MVP schedules nothing; poll posting is `!postpoll`/`poll`-triggered (research §8).
  const statCaptureDays = parseInteger('STAT_CAPTURE_DAYS', 3); // 3 days

  // Timezone (default Europe/London)
  const timezone = optional('TIMEZONE', 'Europe/London');

  // Node environment
  const nodeEnv = optional('NODE_ENV', 'development') as EnvironmentConfig['nodeEnv'];

  return {
    teamName,
    clubUrl,
    authorizedGroupId,
    manvfatUsername,
    manvfatPassword,
    manvfatCredentialKey,
    databasePath,
    statCaptureDays,
    timezone,
    nodeEnv,
  };
}

/**
 * Resolve the authorized group JID for group-dependent commands (`daemon`, `poll`).
 *
 * `AUTHORIZED_GROUP_ID` is optional in the loaded config (group-free commands like `fixtures`,
 * `sync`, and `connect` do not need it), but `daemon`/`poll` require it. Callers map the thrown
 * {@link ConfigError} to CLI exit code `3` (missing config — cli-commands.md).
 */
export function requireAuthorizedGroupId(config: EnvironmentConfig = getEnv()): string {
  if (!config.authorizedGroupId) {
    throw new ConfigError(
      'AUTHORIZED_GROUP_ID is required for this command. Run "captain-stats connect" to ' +
        'discover your group JID, then set AUTHORIZED_GROUP_ID in .env.'
    );
  }
  return config.authorizedGroupId;
}

/**
 * Resolve the MAN v FAT portal credentials for paths that need to log in (currently `init`
 * seeding — FR-010).
 *
 * Like {@link requireAuthorizedGroupId}, the username/password are optional in the loaded config
 * (group-free, scrape-free commands never need them) but required on demand. This is the single
 * place that requirement is enforced, keeping the config boundary — not `process.env` — the source
 * of truth. Callers map the thrown {@link ConfigError} to exit code 2.
 */
export function requireManvfatCredentials(config: EnvironmentConfig = getEnv()): {
  username: string;
  password: string;
} {
  if (!config.manvfatUsername || !config.manvfatPassword) {
    throw new ConfigError(
      'MANVFAT_USERNAME / MANVFAT_PASSWORD are required to seed MAN v FAT credentials. ' +
        'The fixtures page is gated behind a WordPress login — set both in .env before running init.'
    );
  }
  return { username: config.manvfatUsername, password: config.manvfatPassword };
}

/**
 * Resolve and validate the MAN v FAT credential key for crypto operations (FR-009).
 *
 * Like {@link requireAuthorizedGroupId}, the key is optional in the loaded config (most
 * commands never encrypt anything) but required by any path that reads or writes the
 * encrypted password/cookie. This is the single place the key is sourced, decoded, and
 * length-checked; `src/utils/crypto.ts` is a pure primitive that just receives the
 * returned 32-byte buffer. Callers map the thrown {@link ConfigError} to exit code 2.
 */
export function getCredentialKey(config: EnvironmentConfig = getEnv()): Buffer {
  if (!config.manvfatCredentialKey) {
    throw new ConfigError(
      'MANVFAT_CREDENTIAL_KEY is required to encrypt/decrypt MAN v FAT credentials. ' +
        'Generate a 32-byte base64 key with: openssl rand -base64 32, then set it in .env.'
    );
  }

  const key = Buffer.from(config.manvfatCredentialKey, 'base64');
  if (key.length !== 32) {
    throw new ConfigError(
      'Invalid MANVFAT_CREDENTIAL_KEY: must decode to exactly 32 bytes. ' +
        'Generate a valid key with: openssl rand -base64 32'
    );
  }

  return key;
}

/**
 * Singleton instance of environment configuration
 */
let envConfig: EnvironmentConfig | null = null;

/**
 * Get the environment configuration (cached)
 */
export function getEnv(): EnvironmentConfig {
  if (!envConfig) {
    envConfig = loadEnvironmentConfig();
  }
  return envConfig;
}

/**
 * Reload environment configuration (useful for testing)
 */
export function reloadEnv(): EnvironmentConfig {
  envConfig = loadEnvironmentConfig();
  return envConfig;
}
