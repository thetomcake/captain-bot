/**
 * In-memory fake implementing the MVP's {@link IWhatsAppGateway} port (replaces the deleted
 * MockWhatsAppClient). Service-boundary fake only — imports NO Baileys.
 *
 * Records what the MVP sent (`sentPolls` with their returned keysets, `sentMessages`,
 * `deletedMessages`), exposes failure toggles (`failNextSendPoll`, `deleteOutcomeOverride`), and
 * drives MVP handlers via `simulateMessage` / `simulatePollVote`.
 */
import type {
  IWhatsAppGateway,
  ConnectionStatus,
  GroupSummary,
  IncomingMessage,
  MessageRef,
  DeleteOutcome,
  PollSpec,
  PollSendResult,
  PollVote,
  Identity,
} from '#src/whatsapp/gateway-port.js';

export interface SentPoll {
  groupId: string;
  poll: PollSpec;
  ref: MessageRef;
  keyset: PollSendResult['keyset'];
}

export interface SentMessage {
  groupId: string;
  text: string;
  ref: MessageRef;
}

/** Canonical Identity fixtures so identity-keyed assertions (SC-008) are exercised. */
export const IDENTITIES = {
  alice: {
    canonicalId: '447700900001@s.whatsapp.net',
    pn: '447700900001@s.whatsapp.net',
    displayHint: 'Alice',
  },
  bob: {
    canonicalId: '447700900002@s.whatsapp.net',
    pn: '447700900002@s.whatsapp.net',
    displayHint: 'Bob',
  },
  // Same person as alice, arriving under the LID address form — must collapse to one row.
  aliceLid: {
    canonicalId: '447700900001@s.whatsapp.net',
    lid: '111111111111111@lid',
    displayHint: 'Alice',
  },
} satisfies Record<string, Identity>;

export const TEST_GROUP_ID = '120363000000000000@g.us';

export class FakeGateway implements IWhatsAppGateway {
  readonly sentPolls: SentPoll[] = [];
  readonly sentMessages: SentMessage[] = [];
  readonly deletedMessages: MessageRef[] = [];

  /** When true, the next sendPoll() rejects (simulates a WhatsApp send failure). */
  failNextSendPoll = false;
  /** When set, every deleteMessage() returns this outcome instead of `{ ok: true }`. */
  deleteOutcomeOverride: DeleteOutcome | null = null;

  groups: GroupSummary[] = [{ id: TEST_GROUP_ID, name: 'Test Group', addressingMode: 'pn' }];

  private connected = false;
  private connectionStatus: ConnectionStatus = 'closed';
  private seq = 0;

  private qrHandlers: Array<(qr: string) => void> = [];
  private connectionHandlers: Array<(s: ConnectionStatus) => void> = [];
  private messageHandlers: Array<(m: IncomingMessage) => void | Promise<void>> = [];
  private pollVoteHandlers: Array<(v: PollVote) => void | Promise<void>> = [];

  async connect(): Promise<void> {
    this.connected = true;
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.setStatus('closed');
  }

  isConnected(): boolean {
    return this.connected;
  }

  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  async listGroups(): Promise<GroupSummary[]> {
    return this.groups;
  }

  async sendMessage(groupId: string, text: string): Promise<MessageRef> {
    const ref: MessageRef = { id: `fake-msg-${++this.seq}`, groupId };
    this.sentMessages.push({ groupId, text, ref });
    return ref;
  }

  async sendPoll(groupId: string, poll: PollSpec): Promise<PollSendResult> {
    if (this.failNextSendPoll) {
      this.failNextSendPoll = false;
      throw new Error('Simulated sendPoll failure');
    }
    const id = `fake-poll-${++this.seq}`;
    const ref: MessageRef = { id, groupId };
    const keyset = {
      pollId: id,
      groupId,
      messageSecret: `fake-secret-${this.seq}`,
      options: [...poll.options],
    };
    this.sentPolls.push({ groupId, poll, ref, keyset });
    return { ref, keyset };
  }

  async deleteMessage(ref: MessageRef): Promise<DeleteOutcome> {
    this.deletedMessages.push(ref);
    return this.deleteOutcomeOverride ?? { ok: true };
  }

  onQR(handler: (qr: string) => void): void {
    this.qrHandlers.push(handler);
  }

  onConnectionChange(handler: (s: ConnectionStatus) => void): void {
    this.connectionHandlers.push(handler);
  }

  onMessage(handler: (m: IncomingMessage) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onPollVote(handler: (v: PollVote) => void | Promise<void>): void {
    this.pollVoteHandlers.push(handler);
  }

  // ── Test drivers ────────────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const h of this.connectionHandlers) h(status);
  }

  /** Drive a fake QR emission. */
  async simulateQR(qr: string): Promise<void> {
    for (const h of this.qrHandlers) h(qr);
  }

  /** Drive an inbound group message through the registered onMessage handlers. */
  async simulateMessage(msg: Partial<IncomingMessage>): Promise<void> {
    const full: IncomingMessage = {
      id: msg.id ?? `fake-in-${++this.seq}`,
      groupId: msg.groupId ?? TEST_GROUP_ID,
      sender: msg.sender ?? IDENTITIES.alice,
      text: msg.text ?? null,
      timestamp: msg.timestamp ?? new Date(),
      fromMe: msg.fromMe ?? false,
    };
    for (const h of this.messageHandlers) await h(full);
  }

  /** Drive a poll-vote delta through the registered onPollVote handlers. */
  async simulatePollVote(vote: PollVote): Promise<void> {
    for (const h of this.pollVoteHandlers) await h(vote);
  }

  /** Reset all recorded state and handlers between tests. */
  reset(): void {
    this.sentPolls.length = 0;
    this.sentMessages.length = 0;
    this.deletedMessages.length = 0;
    this.failNextSendPoll = false;
    this.deleteOutcomeOverride = null;
    this.connected = false;
    this.connectionStatus = 'closed';
    this.seq = 0;
    this.qrHandlers.length = 0;
    this.connectionHandlers.length = 0;
    this.messageHandlers.length = 0;
    this.pollVoteHandlers.length = 0;
  }
}
