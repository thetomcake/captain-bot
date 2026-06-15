import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';
import { FixtureService } from '../../services/fixture-service.js';
import { PollService } from '../../services/poll-service.js';
import { createGateway } from '../../whatsapp/gateway-factory.js';
import type { IWhatsAppGateway } from '../../whatsapp/gateway-port.js';

export interface PollCommandOptions {
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface PollCommandDeps {
  /** Inject a fake Gateway in tests; production builds one via the factory. */
  gateway?: IWhatsAppGateway;
  /** Inject a FixtureService over a static-HTML scraper in tests (never a real fetch). */
  fixtureService?: FixtureService;
}

/**
 * `poll` command (T030) — the admin escape hatch for the in-chat `!postpoll` trigger.
 *
 * Re-fetches fixtures on demand (FR-003) and posts the next confirmed fixture's availability poll
 * via the Gateway port, or force-replaces an existing one (FR-027). `--dry-run` previews without
 * sending. Exit codes (cli-commands.md): `0` success · `1` no confirmed fixture / fetch failure
 * (FR-028) · `2` poll exists and `--force` not given · `3` `AUTHORIZED_GROUP_ID` unset · `4`
 * runtime/connection failure.
 */
export async function pollCommand(
  options: PollCommandOptions = {},
  deps: PollCommandDeps = {}
): Promise<void> {
  try {
    const { db } = getDatabase();

    const groupId = process.env.AUTHORIZED_GROUP_ID;
    if (!groupId) {
      console.error(
        'Error: AUTHORIZED_GROUP_ID not set. Run "captain-stats connect" to discover your ' +
          'group JID, then set AUTHORIZED_GROUP_ID in .env.'
      );
      process.exit(3);
      return;
    }

    const fixtureService =
      deps.fixtureService ?? new FixtureService(db, new SeasonService(db));

    // Dry run — re-fetch + preview, send nothing.
    if (options.dryRun) {
      const previewService = new PollService(db, fixtureService, deps.gateway as IWhatsAppGateway, groupId);
      const preview = await previewService.previewNextPoll();
      if (preview.outcome === 'fetch-failed') {
        console.error(`Could not reach the club site: ${preview.error}`);
        process.exit(1);
        return;
      }
      if (preview.outcome === 'no-fixture') {
        console.error('No confirmed next fixture to poll.');
        process.exit(1);
        return;
      }
      if (options.json) {
        console.log(
          JSON.stringify({
            dryRun: true,
            opponent: preview.fixture.opponent,
            question: preview.question,
            options: preview.options,
          })
        );
      } else {
        console.log('Dry run — poll would be posted:');
        console.log('');
        console.log(`Next fixture: vs ${preview.fixture.opponent} at ${preview.fixture.venue}`);
        console.log(`Question: ${preview.question}`);
        console.log(`Options: ${preview.options.join(' / ')}`);
      }
      process.exit(0);
      return;
    }

    const gateway = deps.gateway ?? (await createGateway());
    if (!gateway.isConnected()) {
      await gateway.connect();
    }

    const pollService = new PollService(db, fixtureService, gateway, groupId);
    const result = await pollService.postOrReplaceNextPoll({ force: options.force });

    switch (result.outcome) {
      case 'fetch-failed':
        console.error(`Could not reach the club site: ${result.error}`);
        process.exit(1);
        return;
      case 'no-fixture':
        console.error('No confirmed next fixture to poll.');
        process.exit(1);
        return;
      case 'exists':
        console.error('Poll already posted for the next fixture. Use --force to replace it.');
        process.exit(2);
        return;
      case 'posted':
      case 'replaced': {
        if (options.json) {
          console.log(
            JSON.stringify({
              outcome: result.outcome,
              pollMessageId: result.ref.id,
              opponent: result.fixture.opponent,
            })
          );
        } else {
          const verb = result.outcome === 'replaced' ? 'replaced' : 'posted';
          console.log(`✓ Poll ${verb} for the next fixture vs ${result.fixture.opponent}`);
          console.log(`✓ Poll ref: ${result.ref.id}`);
        }
        process.exit(0);
        return;
      }
    }
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
