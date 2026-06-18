/**
 * The single integration seam between the MVP and the WhatsApp Gateway library
 * (`src/whatsapp-gateway/index.ts`, spec 002). Satisfies FR-006/SC-011: MVP services and
 * commands depend on this port, never on the concrete `WhatsAppGateway` and never on Baileys.
 *
 * The real `WhatsAppGateway` satisfies this interface structurally (it exposes a superset —
 * also `forceReauth`/`getCredentials`); the test `FakeGateway` implements it in memory.
 *
 * All types are imported from the Gateway's public surface and re-exported here so MVP code has
 * one place to import WhatsApp shapes from. No new WhatsApp types are invented.
 */
import type {
  ConnectionStatus,
  GroupSummary,
  IncomingMessage,
  MessageRef,
  DeleteOutcome,
  PinOutcome,
  PollSpec,
  PollSendResult,
  PollVote,
} from '#src/whatsapp-gateway/index.js';

export type {
  ConnectionStatus,
  GroupSummary,
  IncomingMessage,
  MessageRef,
  DeleteOutcome,
  PinOutcome,
  PollSpec,
  PollSendResult,
  PollVote,
  Identity,
  WhatsAppCredentials,
  PollKeyset,
  PollRef,
} from '#src/whatsapp-gateway/index.js';

/** The narrow Gateway surface MVP services and commands consume. */
export interface IWhatsAppGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  status(): ConnectionStatus;

  listGroups(): Promise<GroupSummary[]>;
  sendMessage(groupId: string, text: string): Promise<MessageRef>;
  sendPoll(groupId: string, poll: PollSpec): Promise<PollSendResult>; // { ref, keyset }
  deleteMessage(ref: MessageRef): Promise<DeleteOutcome>; // never throws

  /** Pin an already-sent message for ~`durationSeconds` (gateway maps to the nearest WhatsApp bucket). */
  pinMessage(ref: MessageRef, durationSeconds: number): Promise<PinOutcome>; // never throws
  /** Unpin an already-sent message. */
  unpinMessage(ref: MessageRef): Promise<PinOutcome>; // never throws

  onQR(handler: (qr: string) => void): void;
  onConnectionChange(handler: (s: ConnectionStatus) => void): void;
  onMessage(handler: (m: IncomingMessage) => void | Promise<void>): void;
  onPollVote(handler: (v: PollVote) => void | Promise<void>): void;
}
