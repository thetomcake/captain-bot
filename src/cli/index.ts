#!/usr/bin/env node

/**
 * Captain Stats CLI Entry Point
 *
 * Main entry point for the Captain Stats CLI tool.
 * Handles command routing and error handling.
 */

import minimist from 'minimist';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEnvironmentConfig } from '../config/env.js';
import { ConfigError } from '../utils/errors.js';
import { formatError, printError } from './output/formatter.js';

// Get current directory in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf-8')
);
const VERSION = packageJson.version;

async function main(): Promise<void> {
  // Parse arguments with minimist (handles edge cases properly)
  const parsed = minimist(process.argv.slice(2), {
    string: ['config'],
    boolean: ['help', 'version', 'json'],
    alias: { c: 'config', h: 'help', v: 'version' },
  });

  // Load environment config early (before any other processing)
  try {
    loadEnvironmentConfig(parsed.config);
  } catch (error) {
    if (error instanceof ConfigError) {
      printError(formatError(error));
      process.exit(error.statusCode);
    }
    throw error; // Re-throw unexpected errors
  }

  // Handle version flag
  if (parsed.version) {
    console.log(`captain-stats v${VERSION}`);
    process.exit(0);
  }

  // Handle help flag
  if (parsed.help) {
    console.log('Captain Stats - MAN v FAT Football team management tool');
    process.exit(0);
  }

  // Get command from positional arguments
  const command = parsed._[0];

  if (!command) {
    console.log(`Captain Stats CLI v${VERSION}`);
    console.log('');
    console.log('Usage: captain-stats <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  init       Initialize configuration and database');
    console.log('  fixtures   View team fixtures');
    console.log('  sync       Sync fixtures from club website');
    console.log('  stats      View and edit game statistics');
    console.log('  poll       Post availability poll to WhatsApp');
    console.log('  daemon     Run WhatsApp monitoring daemon');
    console.log('  seasons    View season history');
    console.log('');
    console.log('Global Options:');
    console.log('  --config, -c <path>  Config file path (default: .env)');
    console.log('  --help, -h           Show help');
    console.log('  --version, -v        Show version');
    console.log('  --json               JSON output format');
    process.exit(0);
  }

  // Command routing
  switch (command) {
    case 'init': {
      const { initCommand } = await import('./commands/init.js');
      await initCommand({
        teamName: parsed['team-name'],
        clubUrl: parsed['club-url'],
      });
      break;
    }

    case 'fixtures': {
      const { fixturesCommand } = await import('./commands/fixtures.js');
      await fixturesCommand({
        all: parsed.all,
        season: parsed.season ? parseInt(parsed.season) : undefined,
        json: parsed.json,
      });
      break;
    }

    case 'sync': {
      const { syncCommand } = await import('./commands/sync.js');
      await syncCommand({
        teamId: parsed['team-id'] ? parseInt(parsed['team-id']) : undefined,
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "captain-stats" to see available commands');
      process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
