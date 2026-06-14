// Manual entry point (US2): print genuine inbound messages from the authorized group.
//
// Run: WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=123@g.us \
//        npx tsx src/whatsapp-gateway/bin/listen.ts
//
// Long-running: connects (resuming from the persisted snapshot — run bin/connect.ts once
// first to pair) and prints each authorized-group `notify` message (sender, text, ts). It
// must NOT print messages from other chats, nor the gateway's own programmatic sends / history
// (these arrive as `append`). The operator IS a participant, so messages you type manually from
// your own phone ARE printed (notify + fromMe). (quickstart.md Scenario D, FR-014/FR-015/FR-017.)
// Ctrl-C to stop. Imports ONLY the library's public surface (../index.js), proving SC-001.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';
const groupId = process.env.WA_GROUP_ID;

if (!groupId) {
  console.error('Missing required env var WA_GROUP_ID (the …@g.us group JID to listen to).');
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

// Set WA_DEBUG=1 to trace why inbound messages are/aren't dispatched. Baileys itself is
// extremely chatty at debug, so we surface ONLY the Gateway's own diagnostics (its messages
// are prefixed "WhatsAppGateway:") and drop Baileys' internal debug noise.
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
  logger,
});

gateway.onConnectionChange((status) => {
  console.log(`[connection] ${status}`);
});

gateway.onMessage((msg) => {
  const who = msg.sender.displayHint ?? msg.sender.canonicalId;
  const when = msg.timestamp.toISOString();
  console.log(`\n[${when}] ${who}: ${msg.text ?? '(no text content)'}`);
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
  console.log(`\n✅ connected — listening for messages in ${groupId}. Ctrl-C to stop.`);
} catch (err) {
  console.error('\n❌ connection failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
