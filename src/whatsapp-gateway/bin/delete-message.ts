// Manual entry point (US5): best-effort delete (revoke for everyone) of a message/poll the
// Gateway previously sent.
//
// Run: WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=123@g.us WA_MESSAGE_ID=<id-from-send> \
//        npx tsx src/whatsapp-gateway/bin/delete-message.ts
//
// Connects (resuming from the persisted snapshot — run bin/connect.ts once first to pair),
// revokes the message referenced by WA_GROUP_ID + WA_MESSAGE_ID (use the id printed by
// send-message / send-poll), prints the DeleteOutcome, then exits (quickstart.md Scenario F).
// A rejected revoke (out-of-window / unknown id) prints a clear, NON-FATAL reason and the
// script still exits 0 — best-effort delete never crashes (FR-028). Imports ONLY the library's
// public surface (../index.js), proving SC-001.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';
const groupId = process.env.WA_GROUP_ID;
const messageId = process.env.WA_MESSAGE_ID;

if (!groupId) {
  console.error('Missing required env var WA_GROUP_ID (the …@g.us group JID the message is in).');
  process.exit(1);
}
if (!messageId) {
  console.error(
    'Missing required env var WA_MESSAGE_ID (the message id printed by send-message / send-poll).'
  );
  process.exit(1);
}

function readCredentials(): WhatsAppCredentials | undefined {
  if (!existsSync(credsFile)) {
    return undefined;
  }
  try {
    // The snapshot is an opaque string — store/return it verbatim.
    return readFileSync(credsFile, 'utf-8');
  } catch (err) {
    console.error(`Could not read ${credsFile}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

const logger = {
  debug: () => {}, // Baileys is very chatty at debug; suppress for a readable console.
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
  const outcome = await gateway.deleteMessage({ id: messageId, groupId });
  if (outcome.ok) {
    console.log(`\n✅ deleted — DeleteOutcome: ${JSON.stringify(outcome)}`);
  } else {
    // Best-effort: a rejection is reported clearly and is NOT a crash (FR-028).
    console.log(`\n⚠️  not deleted (best-effort) — DeleteOutcome: ${JSON.stringify(outcome)}`);
  }
  await gateway.disconnect();
  process.exit(0);
} catch (err) {
  // Only true setup/connection failures reach here — the delete itself never throws.
  console.error('\n❌ failed to run delete:', err instanceof Error ? err.message : err);
  process.exit(1);
}
