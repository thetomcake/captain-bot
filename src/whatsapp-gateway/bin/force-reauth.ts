// Manual entry point (US1): force a fresh login (FR-007).
//
// Run: WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/force-reauth.ts
//
// Establishes a live socket FIRST (when stored credentials exist) so a real best-effort
// logout is actually attempted against WhatsApp — then clears in-memory creds and, as the
// consumer, deletes its own credentials file so the next connect() requires a fresh QR.
// If no credentials are stored, there is nothing to log out: file deletion is the sole
// mechanism (documented per quickstart Scenario B). Imports ONLY ../index.js.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { WhatsAppGateway, type WhatsAppCredentials } from '../index.js';

const credsFile = process.env.WA_CREDS_FILE ?? './.wa-creds.json';

function readCredentials(): WhatsAppCredentials | undefined {
  if (!existsSync(credsFile)) {
    return undefined;
  }
  try {
    return readFileSync(credsFile, 'utf-8');
  } catch {
    return undefined;
  }
}

const logger = {
  debug: () => {},
  info: (...args: unknown[]) => console.log('[info]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
};

const storedCredentials = readCredentials();

const gateway = new WhatsAppGateway({
  // Auth-only: no authorizedGroups needed.
  credentials: storedCredentials,
  // No onCredentialsUpdate persistence here — we are about to discard the session.
  logger,
});

gateway.onConnectionChange((status) => console.log(`[connection] ${status}`));

if (storedCredentials) {
  // Bring up a real socket so logout() reaches WhatsApp (FR-007).
  try {
    console.log('Connecting before logout so a real logout is attempted…');
    await gateway.connect();
  } catch (err) {
    console.warn(
      'Could not establish a connection before logout; clearing local state anyway:',
      err instanceof Error ? err.message : err
    );
  }
} else {
  console.log('No stored credentials found — nothing to log out; will ensure the file is removed.');
}

await gateway.forceReauth();

try {
  if (existsSync(credsFile)) {
    unlinkSync(credsFile);
    console.log(`Deleted credentials file ${credsFile}`);
  }
} catch (err) {
  console.error(`Failed to delete ${credsFile}:`, err instanceof Error ? err.message : err);
}

console.log('✅ forced re-auth complete — the next connect() will require a fresh QR.');
process.exit(0);
