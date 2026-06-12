import qrcode from 'qrcode-terminal';
import { createRequire } from 'module';
import { getDatabase } from '../../database/client.js';
import * as schema from '../../database/schema.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { PollService } from '../../services/poll-service.js';
import { WhatsAppClient } from '../../whatsapp/client.js';
import { MessageHandler } from '../../whatsapp/message-handler.js';
import { logger } from '../../utils/logger.js';
import { Cron } from 'croner';

const _require = createRequire(import.meta.url);
const { version } = _require('../../package.json') as { version: string };

export interface DaemonCommandOptions {
  foreground?: boolean;
  log?: string;
}

/**
 * Daemon command — long-running WhatsApp monitor with scheduled poll posting
 *
 * Connects to WhatsApp (QR auth on first run), monitors the authorized group,
 * and posts availability polls automatically the day after each completed game.
 */
export async function daemonCommand(options: DaemonCommandOptions = {}): Promise<void> {
  const groupJid = process.env.AUTHORIZED_GROUP_ID;
  if (!groupJid) {
    console.error(
      'Error: AUTHORIZED_GROUP_ID not configured.\n' +
        'Set AUTHORIZED_GROUP_ID=<your-group-jid> in your .env file.\n' +
        'Get the group JID by running captain-stats daemon and checking the logs after connecting.'
    );
    process.exit(2);
    return;
  }

  const { db } = getDatabase();

  const [team] = await db.select().from(schema.teams).limit(1);
  if (!team) {
    console.error('No team configured. Run "captain-stats init" first.');
    process.exit(2);
    return;
  }
  const teamId = team.id;

  const seasonService = new SeasonService(db);
  const fixtureService = new FixtureService(db, seasonService);

  const season = await seasonService.getCurrentSeason(teamId);
  if (!season) {
    console.error('No current season found. Run "captain-stats init" first.');
    process.exit(3);
    return;
  }

  const client = new WhatsAppClient(db, teamId, season.id, groupJid);
  const pollService = new PollService(db, fixtureService, client, groupJid);
  new MessageHandler(client, groupJid, pollService);

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  let shuttingDown = false;
  let pollJob: Cron | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down daemon...', { signal });
    console.log('\nShutting down Captain Stats daemon...');

    if (pollJob) pollJob.stop();

    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ── Connection setup ───────────────────────────────────────────────────────

  console.log(`Captain Stats Daemon v${version}`);
  console.log('Connecting to WhatsApp...');

  client.onQRCode(qr => {
    console.log('\nScan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.onConnectionUpdate(async state => {
    if (state === 'connected') {
      console.log('\n✓ Connected to WhatsApp');
      console.log(`✓ Monitoring group: ${groupJid}`);
      console.log(`✓ Current season: ${season.seasonNumber}`);

      const nextGame = await pollService.getNextGame(teamId);
      if (nextGame) {
        const dateStr = nextGame.gameDate.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });
        console.log(`✓ Next game: ${dateStr} vs ${nextGame.opponent}`);
      }

      console.log('\nDaemon running. Press Ctrl+C to stop.');
      logger.info('Daemon connected and ready');
    } else if (state === 'disconnected' || state === 'close') {
      logger.warn('WhatsApp connection closed', { state });
    }
  });

  await client.connect();

  // ── Scheduled poll posting (T061) ──────────────────────────────────────────
  // Check every morning at the configured poll hour (default: 9am)
  const pollHour = process.env.POLL_POST_HOUR ? parseInt(process.env.POLL_POST_HOUR) : 9;

  pollJob = new Cron(`0 ${pollHour} * * *`, async () => {
    logger.info('Running scheduled poll check');

    if (!client.isConnected()) {
      logger.warn('Skipping scheduled poll — client disconnected');
      return;
    }

    try {
      const nextGame = await pollService.getNextGame(teamId);
      if (!nextGame) {
        logger.info('No upcoming games — skipping poll');
        return;
      }

      if (await pollService.hasPollForGame(nextGame.id)) {
        logger.info('Poll already posted for next game', { gameId: nextGame.id });
        return;
      }

      const messageId = await pollService.postPollForGame(nextGame.id);
      if (messageId) {
        logger.info('Scheduled poll posted', { gameId: nextGame.id, messageId });
      }
    } catch (error) {
      logger.error('Scheduled poll failed', error instanceof Error ? error : undefined);
    }
  });

  if (!options.foreground) {
    // In background mode we'd use child_process.fork() or similar.
    // For MVP, --foreground is the default operational mode.
    console.log('\n[Note] Background mode not yet implemented. Running in foreground.');
  }
}
