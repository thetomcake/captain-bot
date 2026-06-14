// Manual entry point (US4): list every group the account belongs to.
//
// Run: WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/list-groups.ts
//
// Connects (resuming from the persisted snapshot — run bin/connect.ts once first to pair),
// prints an id / name / addressingMode table, then exits. Use this to discover the group id
// you need for the other entry points (send-message, send-poll, …). An account in no groups
// prints an empty table and exits cleanly (quickstart.md Scenario C). Imports ONLY the
// library's public surface (../index.js), proving SC-001.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';

// list-groups only needs a connection (no group to act in), so it configures no
// authorizedGroups — that is exactly what this script exists to help you discover.

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

gateway.onQR((qr) => {
  console.log('\nScan this QR code with WhatsApp (Linked devices → Link a device):\n');
  qrcode.generate(qr, { small: true });
});

try {
  await gateway.connect();
  const groups = await gateway.listGroups();

  if (groups.length === 0) {
    console.log('\nNo groups found for this account.');
  } else {
    console.log(`\n${groups.length} group(s):\n`);
    for (const group of groups) {
      const mode = group.addressingMode ?? '—';
      console.log(`  ${group.id}  [${mode}]  ${group.name}`);
    }
  }

  await gateway.disconnect();
  process.exit(0);
} catch (err) {
  console.error('\n❌ failed to list groups:', err instanceof Error ? err.message : err);
  process.exit(1);
}
