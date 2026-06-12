/**
 * WhatsApp client interface and real implementation using Baileys
 *
 * Tests use MockWhatsAppClient (tests/helpers/mock-whatsapp.ts) at this service boundary.
 * The real WhatsAppClient is not unit tested — QR authentication requires interactive hardware.
 */

import makeWASocket, {
  DisconnectReason,
  Browsers,
  getAggregateVotesInPollMessage,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../database/schema.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { useDatabaseAuthState } from './auth.js';
import type {
  WhatsAppMessage,
  WhatsAppPoll,
  PollVoteResult,
  ConnectionState,
} from '../types/whatsapp.js';

// ============================================================================
// Service boundary interface — use this in all services and tests
// ============================================================================

export interface IWhatsAppClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendPoll(groupJid: string, poll: WhatsAppPoll): Promise<string>;
  sendMessage(groupJid: string, text: string): Promise<void>;
  onMessage(handler: (msg: WhatsAppMessage) => void | Promise<void>): void;
  onPollVote(
    handler: (messageId: string, votes: PollVoteResult[]) => void | Promise<void>
  ): void;
  onConnectionUpdate(handler: (state: ConnectionState) => void | Promise<void>): void;
  onQRCode(handler: (qr: string) => void): void;
}

// ============================================================================
// Real Baileys-backed implementation (not unit tested — requires QR auth)
// ============================================================================

export class WhatsAppClient implements IWhatsAppClient {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private connected = false;

  private messageHandlers: Array<(msg: WhatsAppMessage) => void | Promise<void>> = [];
  private pollVoteHandlers: Array<
    (messageId: string, votes: PollVoteResult[]) => void | Promise<void>
  > = [];
  private connectionHandlers: Array<(state: ConnectionState) => void | Promise<void>> = [];
  private qrHandlers: Array<(qr: string) => void> = [];

  private readonly rateLimiter: RateLimiter;
  private messageStore = new Map<string, WAMessage>();

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly teamId: number,
    private readonly seasonId: number,
    private readonly authorizedGroupId: string,
    minMessageDelay = 12000
  ) {
    // 12s between messages = max 5 messages/minute per research.md
    this.rateLimiter = new RateLimiter({ minDelay: minMessageDelay });
  }

  async connect(): Promise<void> {
    const { state, saveCreds } = await useDatabaseAuthState(
      this.db,
      this.teamId,
      this.seasonId
    );

    this.sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('CaptainBot'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async update => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        this.qrHandlers.forEach(h => h(qr));
      }

      if (connection === 'open') {
        this.connected = true;
        for (const h of this.connectionHandlers) await h('connected');
      } else if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        const state: ConnectionState =
          statusCode === DisconnectReason.loggedOut ? 'disconnected' : 'close';
        for (const h of this.connectionHandlers) await h(state);
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || !msg.key.id) continue;

        const storeKey = `${remoteJid}:${msg.key.id}`;
        this.messageStore.set(storeKey, msg);

        if (remoteJid !== this.authorizedGroupId) continue;

        const text =
          msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? null;

        const whatsappMsg: WhatsAppMessage = {
          id: msg.key.id,
          fromMe: msg.key.fromMe ?? false,
          remoteJid,
          text,
          timestamp: msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000)
            : new Date(),
          participant: msg.key.participant ?? undefined,
        };

        for (const h of this.messageHandlers) await h(whatsappMsg);
      }
    });

    this.sock.ev.on('messages.update', async updates => {
      for (const { key, update } of updates) {
        if (!update.pollUpdates?.length || !key.remoteJid || !key.id) continue;

        const storeKey = `${key.remoteJid}:${key.id}`;
        const pollMsg = this.messageStore.get(storeKey);
        if (!pollMsg?.message) continue;

        const raw = getAggregateVotesInPollMessage({
          message: pollMsg.message,
          pollUpdates: update.pollUpdates,
        });

        const votes: PollVoteResult[] = raw.map(v => ({
          optionName: v.name,
          voters: v.voters,
          voteCount: v.voters.length,
        }));

        for (const h of this.pollVoteHandlers) await h(key.id, votes);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.connected = false;
      this.sock = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendPoll(groupJid: string, poll: WhatsAppPoll): Promise<string> {
    return this.rateLimiter.execute(async () => {
      if (!this.sock) throw new Error('WhatsApp client not connected');

      const result = await this.sock.sendMessage(groupJid, {
        poll: {
          name: poll.name,
          values: poll.values,
          selectableCount: poll.selectableCount,
        },
      });

      if (!result?.key?.id) {
        throw new Error('Failed to send poll — no message ID returned');
      }

      return result.key.id;
    });
  }

  async sendMessage(groupJid: string, text: string): Promise<void> {
    await this.rateLimiter.execute(async () => {
      if (!this.sock) throw new Error('WhatsApp client not connected');
      await this.sock.sendMessage(groupJid, { text });
    });
  }

  onMessage(handler: (msg: WhatsAppMessage) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onPollVote(
    handler: (messageId: string, votes: PollVoteResult[]) => void | Promise<void>
  ): void {
    this.pollVoteHandlers.push(handler);
  }

  onConnectionUpdate(handler: (state: ConnectionState) => void | Promise<void>): void {
    this.connectionHandlers.push(handler);
  }

  onQRCode(handler: (qr: string) => void): void {
    this.qrHandlers.push(handler);
  }
}
