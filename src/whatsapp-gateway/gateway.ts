// WhatsAppGateway — the Baileys-bound orchestration shell (manual-validated).
//
// This file is the highest-risk area (it owns the live socket), so per the
// implementation discipline the hard logic lives in the pure units this class
// wires together (config, group-filter, identity-resolver, message-store, …) and
// is unit-tested there. This is the SKELETON (T015): construction + config
// validation, handler registries, subscriptions, and status. The socket lifecycle
// (connect/disconnect/reconnect), messaging, polls, groups, and delete — and the
// foundational units they consume — are added by later phases, each of which MUST
// keep its decision logic in a pure unit rather than inlining it here.
import type {
  ConnectionStatus,
  GatewayConfig,
  IncomingMessage,
  PollVote,
} from './types.js';
import { resolveConfig, type ResolvedGatewayConfig } from './config.js';

type QRHandler = (qr: string) => void;
type ConnectionChangeHandler = (status: ConnectionStatus) => void;
type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;
type PollVoteHandler = (vote: PollVote) => void | Promise<void>;

export class WhatsAppGateway {
  private readonly config: ResolvedGatewayConfig;

  // Not yet connected until connect() (added in US1, T023) drives the lifecycle.
  private connectionStatus: ConnectionStatus = 'closed';

  private readonly qrHandlers: QRHandler[] = [];
  private readonly connectionChangeHandlers: ConnectionChangeHandler[] = [];
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly pollVoteHandlers: PollVoteHandler[] = [];

  constructor(config: GatewayConfig) {
    // resolveConfig validates consumer input (throws on a bad authorizedGroups)
    // and applies defaults; later phases read this for delays, reconnect, etc.
    this.config = resolveConfig(config);
    this.config.logger.debug('WhatsAppGateway constructed', {
      authorizedGroups: this.config.authorizedGroups.length,
      minMessageDelayMs: this.config.minMessageDelayMs,
    });
  }

  // ── Status ──────────────────────────────────────────────────────────────────
  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────--
  onQR(handler: QRHandler): void {
    this.qrHandlers.push(handler);
  }

  onConnectionChange(handler: ConnectionChangeHandler): void {
    this.connectionChangeHandlers.push(handler);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onPollVote(handler: PollVoteHandler): void {
    this.pollVoteHandlers.push(handler);
  }
}
