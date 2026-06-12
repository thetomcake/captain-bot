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
  type WAMessageKey,
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

/**
 * After a fresh QR pairing, WhatsApp closes the bootstrap socket with a 515
 * "restartRequired" and expects an immediate reconnect. This is always a
 * pre-open handshake step, so connect() retries through it. Bound the retries
 * so a server stuck in a restart loop fails loudly instead of spinning forever.
 */
const MAX_RESTART_HANDSHAKES = 5;

/** Extract the Boom status code from a Baileys disconnect, if present. */
function disconnectStatusCode(lastDisconnect: { error?: unknown } | undefined): number | undefined {
  return (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
}

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

  /**
   * Connect and resolve once the socket is genuinely open and usable.
   *
   * A fresh pairing closes with 515 (restartRequired) and expects an immediate
   * reconnect with the now-saved credentials; we loop through those handshakes
   * until we either open or hit a non-recoverable close (which rejects).
   */
  async connect(): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RESTART_HANDSHAKES; attempt++) {
      if ((await this.openOnce()) === 'open') return;
      // 'restartRequired' → loop: reload saved creds, open a fresh socket
    }
    throw new Error('WhatsApp restart handshake did not complete after multiple attempts');
  }

  /**
   * Build a socket, wire its listeners, and resolve on the FIRST terminal
   * connection event for THAT socket:
   *   - 'open'            → connected and usable
   *   - 'restartRequired' → server wants a reconnect (caller loops)
   * Rejects on any other close (logged out, connection failure).
   *
   * Each call owns its own Promise, so it settles exactly once by construction —
   * a later event on a discarded socket can only no-op an already-settled Promise.
   */
  private async openOnce(): Promise<'open' | 'restartRequired'> {
    const { state, saveCreds } = await useDatabaseAuthState(
      this.db,
      this.teamId,
      this.seasonId
    );

    const sock = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Required by Baileys to decrypt poll votes: it looks the original poll
      // message up by key to recover the messageSecret. Without this, incoming
      // `pollUpdates` stay encrypted and aggregate to nothing.
      getMessage: async (key: WAMessageKey) => this.getStoredMessage(key),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    this.wireMessageListeners(sock);

    return new Promise<'open' | 'restartRequired'>((resolve, reject) => {
      sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
          this.qrHandlers.forEach(h => h(qr));
        }

        if (connection === 'open') {
          this.connected = true;
          resolve('open');
          await this.notify('connected');
        } else if (connection === 'close') {
          this.connected = false;
          const code = disconnectStatusCode(lastDisconnect);

          if (code === DisconnectReason.restartRequired) {
            resolve('restartRequired');
            return;
          }

          const connState: ConnectionState =
            code === DisconnectReason.loggedOut ? 'disconnected' : 'close';
          reject(new Error(connState === 'disconnected' ? 'Logged out' : 'Connection closed'));
          await this.notify(connState);
        }
      });
    });
  }

  /** Translate Baileys message/poll-vote events into our domain handler arrays. */
  private wireMessageListeners(sock: ReturnType<typeof makeWASocket>): void {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Store every upserted message regardless of `type`. Polls we send are
      // echoed back with type 'append' (not 'notify'); that echo is the only
      // copy of the poll-creation message, and getMessage()/vote aggregation
      // both need it. Filtering on 'notify' here was dropping it.
      for (const msg of messages) {
        if (!msg.key.remoteJid || !msg.key.id) continue;
        this.messageStore.set(`${msg.key.remoteJid}:${msg.key.id}`, msg);
      }

      // Only `notify` carries new inbound activity to route to handlers.
      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || !msg.key.id) continue;

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

    sock.ev.on('messages.update', async updates => {
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

  /** Look a stored message up by key for Baileys' getMessage (poll decryption). */
  private getStoredMessage(key: WAMessageKey): NonNullable<WAMessage['message']> | undefined {
    if (!key.remoteJid || !key.id) return undefined;
    return this.messageStore.get(`${key.remoteJid}:${key.id}`)?.message ?? undefined;
  }

  /** Fire-and-forget notification of connection-state change to subscribers. */
  private async notify(state: ConnectionState): Promise<void> {
    for (const h of this.connectionHandlers) await h(state);
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

      // Persist the poll-creation message immediately so vote decryption works
      // even if the first vote arrives before Baileys echoes the sent message.
      this.messageStore.set(`${groupJid}:${result.key.id}`, result);

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
