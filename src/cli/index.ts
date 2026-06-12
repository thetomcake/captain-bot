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

  // Handle version flag (before loading config)
  if (parsed.version) {
    console.log(`captain-stats v${VERSION}`);
    process.exit(0);
  }

  // Get command from positional arguments
  const command = parsed._[0];

  // Handle global help flag only if no command specified
  if (parsed.help && !command) {
    console.log('Captain Stats - MAN v FAT Football team management tool');
    process.exit(0);
  }

  // Show usage if no command (before loading config)
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
    console.log('  connect    Connect to WhatsApp and list group JIDs');
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

  // Load environment config (after help/version checks, but skip if command-level help requested)
  if (!parsed.help) {
    try {
      loadEnvironmentConfig(parsed.config);
    } catch (error) {
      if (error instanceof ConfigError) {
        // Output plain error message for configuration errors
        console.error(`Configuration error: ${error.message}`);
        process.exit(error.statusCode);
      }
      throw error; // Re-throw unexpected errors
    }
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
      // Handle command-specific help
      if (parsed.help) {
        console.log('Usage: captain-stats fixtures [options]');
        console.log('');
        console.log('View team fixtures');
        console.log('');
        console.log('Options:');
        console.log('  --all              Show all fixtures (including completed)');
        console.log('  --season <number>  Show fixtures for specific season');
        console.log('  --json             Output in JSON format');
        console.log('  --config <path>    Config file path');
        console.log('  --help             Show this help message');
        process.exit(0);
      }

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

    case 'poll': {
      if (parsed.help) {
        console.log('Usage: captain-stats poll [game-id] [options]');
        console.log('');
        console.log('Post availability poll to WhatsApp group');
        console.log('');
        console.log('Options:');
        console.log('  --force      Post poll even if already posted');
        console.log('  --dry-run    Show what would be posted without posting');
        console.log('  --config     Config file path');
        console.log('  --help       Show this help message');
        process.exit(0);
        break;
      }

      const { pollCommand } = await import('./commands/poll.js');
      await pollCommand({
        gameId: parsed._[1] ? parseInt(String(parsed._[1])) : undefined,
        force: parsed.force as boolean | undefined,
        dryRun: parsed['dry-run'] as boolean | undefined,
        json: parsed.json as boolean | undefined,
      });
      break;
    }

    case 'daemon': {
      if (parsed.help) {
        console.log('Usage: captain-stats daemon [options]');
        console.log('');
        console.log('Run WhatsApp monitoring daemon');
        console.log('');
        console.log('Options:');
        console.log('  --foreground, -f  Run in foreground (default)');
        console.log('  --log <path>      Log file path');
        console.log('  --config          Config file path');
        console.log('  --help            Show this help message');
        process.exit(0);
        break;
      }

      const { daemonCommand } = await import('./commands/daemon.js');
      await daemonCommand({
        foreground: parsed.foreground as boolean | undefined,
        log: parsed.log as string | undefined,
      });
      break;
    }

    case 'connect': {
      const { connectCommand } = await import('./commands/connect.js');
      await connectCommand();
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
