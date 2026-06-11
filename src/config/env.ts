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
    throw new ConfigError(`Invalid AUTHORIZED_GROUP_ID: must be a WhatsApp group JID (*@g.us), got: ${jid}`);
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
      `Failed to load config file: ${envPath}\n` +
      `Error: ${result.error.message}`
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

  const databasePath = optional('DATABASE_PATH', path.join(process.cwd(), 'captain-stats.db'));

  // Scheduling defaults
  const pollPostHour = parseInteger('POLL_POST_HOUR', 9); // 9am
  const statCaptureDays = parseInteger('STAT_CAPTURE_DAYS', 3); // 3 days
  const fixtureSyncInterval = parseInteger('FIXTURE_SYNC_INTERVAL', 86400); // 24 hours

  // Timezone
  const timezone = optional('TIMEZONE', 'Europe/London');

  // Node environment
  const nodeEnv = (optional('NODE_ENV', 'development') as EnvironmentConfig['nodeEnv']);

  return {
    teamName,
    clubUrl,
    authorizedGroupId,
    databasePath,
    pollPostHour,
    statCaptureDays,
    fixtureSyncInterval,
    timezone,
    nodeEnv,
  };
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
