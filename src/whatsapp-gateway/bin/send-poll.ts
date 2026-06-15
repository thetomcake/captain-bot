// Manual entry point (US3): post a native single-choice poll to the authorized group and
// persist its keyset so votes can be decrypted later (including after a restart).
//
// Run: WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=123@g.us \
//        WA_POLL_QUESTION='Lunch?' WA_POLL_OPTIONS='Pizza,Sushi,Tacos' \
//        WA_POLL_KEYS_FILE=./.wa-poll-keys.json \
//        npx tsx src/whatsapp-gateway/bin/send-poll.ts
//
// Connects (resuming from the persisted snapshot — run bin/connect.ts once first to pair),
// sends the poll, APPENDS the returned PollKeyset to WA_POLL_KEYS_FILE (one JSON object per
// line — the durable, restart-proof source bin/watch-votes.ts reads back), prints the
// MessageRef, then exits (quickstart.md Scenario E). Imports ONLY the library's public surface
// (../index.js), proving SC-001. Persistence lives here (the consumer), not in the library.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';
const pollKeysFile = process.env.WA_POLL_KEYS_FILE ?? './.wa-poll-keys.json';
const groupId = process.env.WA_GROUP_ID;
const question = process.env.WA_POLL_QUESTION;
const optionsRaw = process.env.WA_POLL_OPTIONS;

if (!groupId) {
  console.error('Missing required env var WA_GROUP_ID (the …@g.us group JID to post to).');
  process.exit(1);
}
if (!question) {
  console.error('Missing required env var WA_POLL_QUESTION (the poll question).');
  process.exit(1);
}
if (!optionsRaw) {
  console.error('Missing required env var WA_POLL_OPTIONS (comma-separated, 2–12 options).');
  process.exit(1);
}

// Split on commas and trim; the library validates the 2–12 non-empty rule before sending.
const options = optionsRaw
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

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

const logger = {
  debug: () => {},
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
  logger,
});

try {
  await gateway.connect();
  const { ref, keyset } = await gateway.sendPoll(groupId, { question, options });
  // Persist the keyset so a later (even post-restart) bin/watch-votes.ts can decrypt votes.
  appendFileSync(pollKeysFile, `${JSON.stringify(keyset)}\n`, 'utf-8');
  console.log(`\n✅ poll sent — MessageRef: ${JSON.stringify(ref)}`);
  console.log(`   keyset appended to ${pollKeysFile} (pollId ${keyset.pollId}).`);
  await gateway.disconnect();
  process.exit(0);
} catch (err) {
  console.error('\n❌ failed to send poll:', err instanceof Error ? err.message : err);
  process.exit(1);
}
