import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import makeWASocket, { Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import { getDatabase } from '../../database/client.js';
import * as schema from '../../database/schema.js';
import { SeasonService } from '../../services/season-service.js';
import { useDatabaseAuthState } from '../../whatsapp/auth.js';

function tryAutoOpen(filePath: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [filePath], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Best-effort only — silently ignore if auto-open is unavailable
  }
}

async function writeQrPng(qr: string): Promise<void> {
  const qrPath = path.join(os.tmpdir(), 'captain-stats-qr.png');
  await QRCode.toFile(qrPath, qr);
  console.log(`QR code saved to: ${qrPath}`);
  tryAutoOpen(qrPath);
}

/**
 * Connect command — authenticates with WhatsApp then lists all group JIDs.
 *
 * Shares the same database-backed auth state as the daemon so no second QR
 * scan is required when the daemon starts afterwards.
 */
export async function connectCommand(): Promise<void> {
  const { db } = getDatabase();

  const [team] = await db.select().from(schema.teams).limit(1);
  if (!team) {
    console.error('Error: No team configured. Run "captain-stats init" first.');
    process.exit(2);
    return;
  }

  const seasonService = new SeasonService(db);
  const season = await seasonService.getCurrentSeason(team.id);
  if (!season) {
    console.error('Error: No current season found. Run "captain-stats init" first.');
    process.exit(2);
    return;
  }

  console.log('Captain Stats - WhatsApp Group Setup');
  console.log('Connecting to WhatsApp...');

  let exiting = false;

  const { state, saveCreds } = await useDatabaseAuthState(db, team.id, season.id);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
      await writeQrPng(qr);
    }

    if (connection === 'open') {
      console.log('\n✓ Connected to WhatsApp');
      console.log('Fetching your groups...\n');

      try {
        const groups = await sock.groupFetchAllParticipating();

        const entries = Object.entries(groups);
        if (entries.length === 0) {
          console.log('No groups found. Make sure the authenticated account is in at least one group.');
        } else {
          const JID_COL = 42;
          const header = 'Group JID'.padEnd(JID_COL) + 'Name';
          const divider = '─'.repeat(JID_COL + 40);
          console.log(header);
          console.log(divider);
          for (const [jid, meta] of entries) {
            console.log(jid.padEnd(JID_COL) + meta.subject);
          }
          console.log('');
          console.log('Set your authorized group in .env:');
          console.log('  AUTHORIZED_GROUP_ID=<group-jid>');
        }
      } catch (error) {
        console.error('Error fetching groups:', error instanceof Error ? error.message : String(error));
        exiting = true;
        await sock.end(undefined);
        process.exit(4);
        return;
      }

      exiting = true;
      await sock.end(undefined);
      process.exit(0);
    }

    if (connection === 'close' && !exiting) {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('Error: WhatsApp session logged out. Re-run to authenticate again.');
      } else {
        console.error('Error: WhatsApp connection closed unexpectedly.');
      }
      process.exit(4);
    }
  });
}
