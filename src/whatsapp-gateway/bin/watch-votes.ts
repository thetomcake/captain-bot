// Manual entry point (US3): watch live poll votes in the authorized group and print a running
// tally, attributing each voter once even across LID/PN forms.
//
// Run: WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=123@g.us \
//        WA_POLL_KEYS_FILE=./.wa-poll-keys.json \
//        npx tsx src/whatsapp-gateway/bin/watch-votes.ts
//
// Long-running: connects (resuming from the persisted snapshot), and for each incoming vote
// prints the per-voter selection plus a running aggregate (via the exported aggregateVotes).
// `resolvePollKeyset` reads WA_POLL_KEYS_FILE (written by bin/send-poll.ts) and returns null for
// an unknown poll — proving the restart-proof fallback path. Within one session the gateway's
// in-memory store already serves the secret for polls it just sent; the keyset file is what
// survives a restart (quickstart.md Scenario E). Ctrl-C to stop. Imports ONLY ../index.js (SC-001).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  WhatsAppGateway,
  aggregateVotes,
  type PollKeyset,
  type PollRef,
  type PollVote,
  type WhatsAppCredentials,
} from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';
const pollKeysFile = process.env.WA_POLL_KEYS_FILE ?? './.wa-poll-keys.json';
const groupId = process.env.WA_GROUP_ID;

if (!groupId) {
  console.error('Missing required env var WA_GROUP_ID (the …@g.us group JID to watch).');
  process.exit(1);
}

function readCredentials(): WhatsAppCredentials | undefined {
  if (!existsSync(credsFile)) {
    return undefined;
  }
  try {
    return readFileSync(credsFile, 'utf-8');
  } catch (err) {
    console.error(`Could not read ${credsFile}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/**
 * Look up a poll's keyset from the file bin/send-poll.ts appends to (one JSON object per line).
 * Returns null when the poll is unknown — the gateway then skips that vote without error. Read
 * fresh each call so polls sent after this watcher started are still resolvable.
 */
function resolvePollKeyset(ref: PollRef): PollKeyset | null {
  if (!existsSync(pollKeysFile)) {
    return null;
  }
  try {
    const lines = readFileSync(pollKeysFile, 'utf-8').split('\n');
    // Iterate newest-last so the most recent keyset for a pollId wins.
    let match: PollKeyset | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const keyset = JSON.parse(trimmed) as PollKeyset;
      if (keyset.pollId === ref.pollId && keyset.groupId === ref.groupId) {
        match = keyset;
      }
    }
    return match;
  } catch (err) {
    console.error(`Could not read ${pollKeysFile}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Set WA_DEBUG=1 to trace poll-vote handling — most usefully the per-vote form snapshot
// ("attempting poll-vote decrypt" / "failed to decrypt poll vote") that shows the exact
// creator/voter JID forms tried vs. what WhatsApp delivered. Baileys itself is very chatty at
// debug, so we surface ONLY the Gateway's own diagnostics (prefixed "WhatsAppGateway:") and drop
// Baileys' internal debug noise. (The "failed to decrypt" line also prints at warn regardless.)
const debugEnabled = process.env.WA_DEBUG === '1' || process.env.WA_DEBUG === 'true';
const logger = {
  debug: (...args: unknown[]) => {
    if (!debugEnabled) {
      return;
    }
    if (typeof args[0] === 'string' && args[0].startsWith('WhatsAppGateway:')) {
      console.log('[debug]', ...args);
    }
  },
  info: (...args: unknown[]) => console.log('[info]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
};

const gateway = new WhatsAppGateway({
  authorizedGroups: [groupId],
  credentials: readCredentials(),
  onCredentialsUpdate: (creds) => {
    try {
      writeFileSync(credsFile, creds, 'utf-8');
    } catch (err) {
      console.error(
        `Failed to persist credentials to ${credsFile}:`,
        err instanceof Error ? err.message : err
      );
    }
  },
  resolvePollKeyset,
  logger,
});

gateway.onConnectionChange((status) => {
  console.log(`[connection] ${status}`);
});

// Accumulate every per-voter delta and re-aggregate (last-write-per-voter, LID/PN-canonical).
const votes: PollVote[] = [];

gateway.onPollVote((vote) => {
  votes.push(vote);
  const who = vote.voter.displayHint ?? vote.voter.canonicalId;
  const selection =
    vote.selectedOptions.length > 0 ? vote.selectedOptions.join(', ') : '(withdrawn)';
  console.log(`\n[vote] ${who} → ${selection}  (poll ${vote.pollId})`);

  const result = aggregateVotes(votes.filter((v) => v.pollId === vote.pollId));
  console.log(`  current tally for poll ${result.pollId}:`);
  if (result.options.length === 0) {
    console.log('    (no current selections)');
  }
  for (const option of result.options) {
    console.log(`    ${option.name}: ${option.voteCount}`);
  }
});

async function shutdown(): Promise<void> {
  console.log('\nShutting down…');
  try {
    await gateway.disconnect();
  } catch {
    // best-effort
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await gateway.connect();
  console.log(`\n✅ connected — watching votes in ${groupId}. Ctrl-C to stop.`);
} catch (err) {
  console.error('\n❌ connection failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
