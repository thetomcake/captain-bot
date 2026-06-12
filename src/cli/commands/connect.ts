import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import makeWASocket, { Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import { getDatabase } from '../../database/client.js';
import * as schema from '../../database/schema.js';
import { SeasonService } from '../../services/season-service.js';
import { eq, and } from 'drizzle-orm';
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

export interface ConnectCommandOptions {
  reset?: boolean;
}

/**
 * Connect command — authenticates with WhatsApp then lists all group JIDs.
 *
 * Shares the same database-backed auth state as the daemon so no second QR
 * scan is required when the daemon starts afterwards.
 *
 * After a successful QR scan, WhatsApp sends a 515 "restartRequired" close —
 * this is normal post-pairing behaviour. We reconnect once and proceed.
 *
 * Pass --reset to wipe stale auth state and force a fresh QR scan.
 */
export async function connectCommand(options: ConnectCommandOptions = {}): Promise<void> {
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

  if (options.reset) {
    await db
      .delete(schema.authStates)
      .where(and(eq(schema.authStates.teamId, team.id), eq(schema.authStates.seasonId, season.id)));
    console.log('Auth state cleared. You will be prompted for a fresh QR scan.');
  }

  console.log('Captain Stats - WhatsApp Group Setup');
  console.log('Connecting to WhatsApp...');

  let exiting = false;
  let reconnects = 0;

  const startSocket = async (): Promise<void> => {
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

        if (statusCode === DisconnectReason.restartRequired && reconnects < 1) {
          // Normal post-QR-scan server restart — reconnect once with saved credentials
          reconnects++;
          void startSocket();
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            'Error: WhatsApp session is invalid or logged out.\n' +
            'If this follows an interrupted setup, clear the stale auth state and retry:\n' +
            '  captain-stats connect --reset'
          );
          process.exit(4);
        } else {
          console.error('Error: WhatsApp connection closed unexpectedly.');
          process.exit(4);
        }
      }
    });
  };

  await startSocket();
}
