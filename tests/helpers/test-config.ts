import type { EnvironmentConfig } from '#src/types/config.js';

/**
 * Standard test configuration - no .env files, all in memory
 */
export function createTestConfig(overrides?: Partial<EnvironmentConfig>): EnvironmentConfig {
  return {
    teamName: overrides?.teamName ?? 'Test Team',
    clubUrl: overrides?.clubUrl ?? 'https://manvfatfootball.com/club/watford/',
    databasePath: ':memory:', // Always in-memory for tests
    authorizedGroupId: overrides?.authorizedGroupId,
    pollPostHour: overrides?.pollPostHour ?? 9,
    statCaptureDays: overrides?.statCaptureDays ?? 3,
    fixtureSyncInterval: overrides?.fixtureSyncInterval ?? 86400,
    timezone: overrides?.timezone ?? 'Europe/London',
    nodeEnv: 'test',
  };
}

/**
 * Set environment variables for tests that read from process.env
 * No cleanup needed - just set fresh values for each test
 */
export function setTestEnvironment(config: EnvironmentConfig): void {
  process.env.TEAM_NAME = config.teamName;
  process.env.CLUB_URL = config.clubUrl;
  process.env.DATABASE_PATH = config.databasePath;
  process.env.AUTHORIZED_GROUP_ID = config.authorizedGroupId ?? '';
  process.env.POLL_POST_HOUR = String(config.pollPostHour);
  process.env.STAT_CAPTURE_DAYS = String(config.statCaptureDays);
  process.env.FIXTURE_SYNC_INTERVAL = String(config.fixtureSyncInterval);
  process.env.TIMEZONE = config.timezone;
  process.env.NODE_ENV = config.nodeEnv;
}
