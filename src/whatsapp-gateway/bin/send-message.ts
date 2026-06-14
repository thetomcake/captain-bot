// Manual entry point (US2): send a text message to the authorized group.
//
// Run: WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=123@g.us WA_TEXT='hello' \
//        npx tsx src/whatsapp-gateway/bin/send-message.ts
//
// Connects (resuming from the persisted snapshot — run bin/connect.ts once first to pair),
// sends one text message to WA_GROUP_ID, prints the returned MessageRef, then exits
// (quickstart.md Scenario D). Imports ONLY the library's public surface (../index.js),
// proving SC-001. Credential persistence lives here (the consumer), not in the library.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';
const groupId = process.env.WA_GROUP_ID;
const text = process.env.WA_TEXT;

if (!groupId) {
  console.error('Missing required env var WA_GROUP_ID (the …@g.us group JID to send to).');
  process.exit(1);
}
if (!text) {
  console.error('Missing required env var WA_TEXT (the message body to send).');
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
  const ref = await gateway.sendMessage(groupId, text);
  console.log(`\n✅ sent — MessageRef: ${JSON.stringify(ref)}`);
  await gateway.disconnect();
  process.exit(0);
} catch (err) {
  console.error('\n❌ failed to send message:', err instanceof Error ? err.message : err);
  process.exit(1);
}
