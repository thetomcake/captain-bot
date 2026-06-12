import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { PollService } from '../../services/poll-service.js';
import type { IWhatsAppClient } from '../../whatsapp/client.js';

export interface PollCommandOptions {
  gameId?: number;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * Poll command — post availability poll to WhatsApp group
 *
 * Accepts an optional `clientOverride` so tests can inject MockWhatsAppClient
 * without touching the real Baileys connection.
 */
export async function pollCommand(
  options: PollCommandOptions = {},
  clientOverride?: IWhatsAppClient
): Promise<void> {
  try {
    const { db } = getDatabase();

    // Require authorized group ID
    const groupJid = process.env.AUTHORIZED_GROUP_ID;
    if (!groupJid) {
      console.error(
        'Error: AUTHORIZED_GROUP_ID not set. Run "captain-stats daemon" first to authorize a WhatsApp group.'
      );
      process.exit(3);
      return;
    }

    const seasonService = new SeasonService(db);
    const fixtureService = new FixtureService(db, seasonService);

    // Resolve team ID (MVP: always team 1)
    const teamId = 1;

    // Find game to poll for
    let targetGameId: number | undefined = options.gameId;

    if (!targetGameId) {
      const season = await seasonService.getCurrentSeason(teamId);
      if (!season) {
        console.error('No current season found. Run "captain-stats init" first.');
        process.exit(3);
        return;
      }

      const upcoming = await fixtureService.getUpcomingFixtures(season.id);
      if (upcoming.length === 0) {
        console.error('No upcoming games found.');
        process.exit(1);
        return;
      }

      targetGameId = upcoming[0]!.id;
    }

    const game = await fixtureService.getGame(targetGameId);
    if (!game) {
      console.error(`Game not found: ${targetGameId}`);
      process.exit(1);
      return;
    }

    const dateStr = game.gameDate.toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = game.gameDate.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });

    // Dry run — show what would be sent without sending
    if (options.dryRun) {
      console.log('Dry run — poll would be posted:');
      console.log('');
      console.log(`Game: ${dateStr} ${timeStr} vs ${game.opponent} at ${game.venue}`);
      console.log('Poll question: Available vs ' + game.opponent + '?');
      console.log('Options: Yes / No / Maybe');
      process.exit(0);
      return;
    }

    // Build client: prefer injected mock, otherwise require real connection
    let client: IWhatsAppClient;
    if (clientOverride) {
      client = clientOverride;
    } else {
      // Lazy-import real client to keep test imports fast
      const { WhatsAppClient } = await import('../../whatsapp/client.js');
      const season = await seasonService.getCurrentSeason(teamId);
      if (!season) {
        console.error('No current season found.');
        process.exit(3);
        return;
      }
      client = new WhatsAppClient(db, teamId, season.id, groupJid);
    }

    const pollService = new PollService(db, fixtureService, client, groupJid);

    // Check if already posted
    if (!options.force && (await pollService.hasPollForGame(targetGameId))) {
      console.error(
        'Poll already posted for this game. Use --force to post again.'
      );
      process.exit(2);
      return;
    }

    // Connect if not already connected
    if (!client.isConnected()) {
      await client.connect();
    }

    const messageId = await pollService.postPollForGame(targetGameId, {
      force: options.force,
    });

    if (!messageId) {
      console.error('Failed to post poll.');
      process.exit(3);
      return;
    }

    console.log('Posting availability poll...');
    console.log('');
    console.log(`Game: ${dateStr} ${timeStr} vs ${game.opponent} at ${game.venue}`);
    console.log('✓ Poll posted to WhatsApp group');
    console.log(`✓ Poll ID: ${messageId}`);
    console.log('');
    console.log('Players can now respond with their availability.');

    process.exit(0);
  } catch (error) {
    if (options.json) {
      console.log(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
    } else {
      console.error('Error:', error instanceof Error ? error.message : String(error));
    }
    process.exit(4);
  }
}
