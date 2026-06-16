/**
 * `daemon` command (T045, FR-010/FR-029) — long-running WhatsApp monitor as a **pure event
 * listener**. No crons: all poll posting and fixture fetching are triggered on demand by the
 * in-chat `!postpoll` command, the `poll` CLI, or `sync` (FR-003/FR-012/FR-029).
 *
 * It builds the Gateway via the factory, subscribes the event router (`onMessage` → `!postpoll`
 * first, else stat capture; `onPollVote` → durable tally) and a connection-state logger, then
 * stays alive on the Gateway's open socket. On `SIGINT`/`SIGTERM` it persists the live credential
 * snapshot, disconnects, and exits `0`.
 */
import { createRequire } from 'module';
import { createGateway } from '../../whatsapp/gateway-factory.js';
import { CredentialsStore } from '../../whatsapp/credentials-store.js';
import { getDatabase } from '../../database/client.js';
import * as schema from '../../database/schema.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { PollService } from '../../services/poll-service.js';
import { StatService } from '../../services/stat-service.js';
import { registerEventRouter } from '../../whatsapp/event-router.js';
import { createPostPollHandler } from '../../whatsapp/postpoll-trigger.js';
import { renderQr } from '../output/qr.js';
import { logger } from '../../utils/logger.js';

const _require = createRequire(import.meta.url);
const { version } = _require('../../../package.json') as { version: string };

export interface DaemonCommandOptions {
  foreground?: boolean;
  log?: string;
}

export async function daemonCommand(_options: DaemonCommandOptions = {}): Promise<void> {
  const groupId = process.env.AUTHORIZED_GROUP_ID;
  if (!groupId) {
    console.error(
      'Error: AUTHORIZED_GROUP_ID not set. Run "captain-stats connect" to discover your ' +
        'group JID, then set AUTHORIZED_GROUP_ID in .env.'
    );
    process.exit(3);
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

  // Build the seam and services. Posting/fetching is entirely trigger-driven — no scheduled jobs.
  const credentialsStore = new CredentialsStore(db);
  const seasonService = new SeasonService(db);
  const fixtureService = new FixtureService(db, seasonService);
  const gateway = await createGateway({ db });
  const pollService = new PollService(db, fixtureService, gateway, groupId);
  const statService = new StatService(db);
  const handlePostPoll = createPostPollHandler({ pollService, gateway, groupId });

  registerEventRouter({ gateway, statService, pollService, handlePostPoll });
  gateway.onConnectionChange((status) => {
    logger.info('Connection state changed', { status });
    if (status === 'connected') {
      console.log(`✓ Connected — monitoring group ${groupId}`);
    }
  });
  gateway.onQR((qr) => renderQr(qr));

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down daemon', { signal });
    console.log('\nShutting down Captain Stats daemon...');
    try {
      const snapshot = gateway.getCredentials();
      if (snapshot) await credentialsStore.save(teamId, snapshot);
    } catch (error) {
      logger.warn('Could not persist credentials on shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await gateway.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ── Connect and run ──────────────────────────────────────────────────────--
  console.log(`Captain Stats Daemon v${version}`);
  console.log('Connecting to WhatsApp...');
  logger.info('Daemon starting', { teamId, groupId });
  await gateway.connect();
  console.log('Daemon running. Press Ctrl+C to stop.');
  logger.info('Daemon connected and listening (no scheduled jobs)');
  // The Gateway's open socket keeps the process alive; we wait for SIGINT/SIGTERM.
}
