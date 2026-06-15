/**
 * Configuration types for Captain Stats application
 */

/**
 * Environment configuration (from .env file)
 */
export interface EnvironmentConfig {
  // Team Configuration
  teamName: string;
  clubUrl: string;

  // WhatsApp
  authorizedGroupId?: string;

  // Database
  databasePath: string;

  // Stat capture window (days after a game that stat messages are accepted, FR-019)
  statCaptureDays: number;

  // Timezone (fixture-date parsing + 3-day stat window; no longer drives any cron — research §8)
  timezone: string;

  // Node environment
  nodeEnv: 'development' | 'production' | 'test';
}

/**
 * CLI command options
 */
export interface CLIOptions {
  json?: boolean;
  config?: string;
  help?: boolean;
  version?: boolean;
}

/**
 * Fixtures command options
 */
export interface FixturesOptions extends CLIOptions {
  all?: boolean;
  season?: number;
}

/**
 * Stats command options
 */
export interface StatsOptions extends CLIOptions {
  edit?: boolean;
  set?: string;
  season?: number;
}

/**
 * Poll command options
 */
export interface PollOptions extends CLIOptions {
  force?: boolean;
  dryRun?: boolean;
}

/**
 * Sync command options
 */
export interface SyncOptions extends CLIOptions {
  force?: boolean;
}

/**
 * Daemon command options
 */
export interface DaemonOptions extends CLIOptions {
  foreground?: boolean;
  log?: string;
}

/**
 * Init command options
 */
export interface InitOptions extends CLIOptions {
  clubUrl?: string;
  team?: string;
  interactive?: boolean;
}

/**
 * Scraper configuration
 */
export interface ScraperConfig {
  url: string;
  timeout: number;
  retries: number;
  userAgent: string;
  useDynamic: boolean; // Use Playwright vs Axios+Cheerio
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
  console: boolean;
}

/**
 * Database configuration
 */
export interface DatabaseConfig {
  path: string;
  enableWAL: boolean;
  foreignKeys: boolean;
}

/**
 * WhatsApp configuration
 */
export interface WhatsAppConfig {
  groupId: string;
  authStatePath: string;
  qrTimeout: number;
  messageRateLimit: number; // messages per minute
}
