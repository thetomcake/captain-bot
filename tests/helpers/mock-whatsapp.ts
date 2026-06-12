import type { IWhatsAppClient } from '#src/whatsapp/client.js';
import type {
  WhatsAppMessage,
  WhatsAppPoll,
  PollVoteResult,
  ConnectionState,
} from '#src/types/whatsapp.js';

export interface SentPoll {
  groupJid: string;
  poll: WhatsAppPoll;
  messageId: string;
}

export interface SentMessage {
  groupJid: string;
  text: string;
}

/**
 * Mock WhatsApp client for service-boundary testing
 * No Baileys imports — implements IWhatsAppClient directly
 */
export class MockWhatsAppClient implements IWhatsAppClient {
  readonly sentPolls: SentPoll[] = [];
  readonly sentMessages: SentMessage[] = [];

  private connected = false;
  private nextMessageId = 1;

  private messageHandlers: Array<(msg: WhatsAppMessage) => void | Promise<void>> = [];
  private pollVoteHandlers: Array<
    (messageId: string, votes: PollVoteResult[]) => void | Promise<void>
  > = [];
  private connectionHandlers: Array<(state: ConnectionState) => void | Promise<void>> = [];
  private qrHandlers: Array<(qr: string) => void> = [];

  async connect(): Promise<void> {
    this.connected = true;
    for (const h of this.connectionHandlers) await h('connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const h of this.connectionHandlers) await h('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendPoll(groupJid: string, poll: WhatsAppPoll): Promise<string> {
    const messageId = `mock-msg-${this.nextMessageId++}`;
    this.sentPolls.push({ groupJid, poll, messageId });
    return messageId;
  }

  async sendMessage(groupJid: string, text: string): Promise<void> {
    this.sentMessages.push({ groupJid, text });
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

  // ── Test helpers ──────────────────────────────────────────────────────────

  /** Simulate an incoming group message */
  async simulateMessage(msg: Partial<WhatsAppMessage>): Promise<void> {
    const fullMsg: WhatsAppMessage = {
      id: msg.id ?? `sim-msg-${Date.now()}`,
      fromMe: msg.fromMe ?? false,
      remoteJid: msg.remoteJid ?? 'test-group@g.us',
      text: msg.text ?? null,
      timestamp: msg.timestamp ?? new Date(),
      participant: msg.participant,
    };
    for (const h of this.messageHandlers) await h(fullMsg);
  }

  /** Simulate a poll vote update */
  async simulatePollVote(messageId: string, votes: PollVoteResult[]): Promise<void> {
    for (const h of this.pollVoteHandlers) await h(messageId, votes);
  }

  /** Reset tracked state between tests */
  reset(): void {
    this.sentPolls.length = 0;
    this.sentMessages.length = 0;
    this.nextMessageId = 1;
    this.connected = false;
    this.messageHandlers.length = 0;
    this.pollVoteHandlers.length = 0;
    this.connectionHandlers.length = 0;
    this.qrHandlers.length = 0;
  }
}
