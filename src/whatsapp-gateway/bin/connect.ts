// Manual entry point (US1): connect & stay connected.
//
// Run: WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/connect.ts
//
// This script is the *consumer* — it owns credential persistence (the library writes
// nothing to disk). It keeps the opaque WhatsAppCredentials snapshot in a local JSON file:
// reads it on start (resume), writes it on every onCredentialsUpdate. Imports ONLY the
// library's public surface (../index.js), proving SC-001. Validates Scenario A in
// quickstart.md: QR on first run, silent resume after, auto-reconnect on a network drop.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';

// connect.ts only exercises the auth lifecycle and never acts in a group, so it configures
// no authorizedGroups — you can pair BEFORE discovering your group id (via list-groups).

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

gateway.onConnectionChange((status) => {
  console.log(`[connection] ${status}`);
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
  console.log('\n✅ connected');
  console.log(`Credentials persisted to ${credsFile}`);
  console.log(
    'Staying connected — drop your network briefly to watch it auto-reconnect. Ctrl-C to stop.'
  );
} catch (err) {
  console.error('\n❌ connection failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
