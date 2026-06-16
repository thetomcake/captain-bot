/**
 * `connect` command (T044, FR-007/FR-011) — Gateway-native pairing + group discovery.
 *
 * Builds the Gateway in discovery mode (no `AUTHORIZED_GROUP_ID` required), renders the pairing QR
 * to the terminal and a saved PNG, then lists every group the account is in as a table
 * `id  [addressingMode]  name` followed by the line to set `AUTHORIZED_GROUP_ID` (printed only —
 * never persisted, FR-011). Shares the persisted credential snapshot with `daemon` (the factory
 * wires `onCredentialsUpdate` → the credential store), so `daemon` needs no second QR scan.
 *
 * `--reset` discards the stored snapshot first so a fresh QR is shown. Exit `0` on success, `4` on
 * a connection failure (cli-commands.md).
 */
import { createGateway } from '../../whatsapp/gateway-factory.js';
import { CredentialsStore } from '../../whatsapp/credentials-store.js';
import { getDatabase } from '../../database/client.js';
import * as schema from '../../database/schema.js';
import { renderQr } from '../output/qr.js';
import { logger } from '../../utils/logger.js';

export interface ConnectCommandOptions {
  reset?: boolean;
}

export async function connectCommand(options: ConnectCommandOptions = {}): Promise<void> {
  try {
    if (options.reset) {
      const { db } = getDatabase();
      const [team] = await db.select().from(schema.teams).limit(1);
      if (team) {
        await new CredentialsStore(db).clear(team.id);
        console.log('Cleared stored WhatsApp credentials — a fresh QR will be shown.');
      }
    }

    // Discovery mode: no authorized group needed to pair and enumerate groups.
    const gateway = await createGateway({ discovery: true });

    gateway.onQR((qr) => renderQr(qr));
    gateway.onConnectionChange((status) => logger.info('Connection state changed', { status }));

    console.log('Connecting to WhatsApp...');
    await gateway.connect();
    console.log('✓ Connected to WhatsApp.\n');

    const groups = await gateway.listGroups();
    if (groups.length === 0) {
      console.log('This account is not a member of any groups.');
    } else {
      console.log('Groups:');
      console.log('');
      for (const group of groups) {
        const mode = group.addressingMode ? `[${group.addressingMode}]` : '[?]';
        console.log(`  ${group.id}  ${mode}  ${group.name}`);
      }
      console.log('');
      console.log('To monitor a group, set its id in your .env:');
      console.log('  AUTHORIZED_GROUP_ID=<id-from-the-table-above>');
    }

    await gateway.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Failed to connect:', error instanceof Error ? error.message : String(error));
    process.exit(4);
  }
}
