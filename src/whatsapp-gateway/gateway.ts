// WhatsAppGateway — the Baileys-bound orchestration shell (manual-validated).
//
// This file owns the live socket and is therefore the highest-risk area, so per the
// implementation discipline ALL hard logic lives in the pure units it wires together
// (config, connection-state reducer, disconnect-classifier, reconnect-policy, auth-state,
// message-store) and is unit-tested there. This shell only translates Baileys events into
// reducer events and acts on the reducer's decisions.
//
// Phase 3 (US1) adds the connection lifecycle: connect / disconnect / forceReauth /
// getCredentials, socket creation wired to the message-store's getMessage, and the
// reducer-driven transitions. Messaging, polls, groups and delete come in later phases.
import makeWASocket, { Browsers } from '@whiskeysockets/baileys';
import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import type {
  ConnectionStatus,
  GatewayConfig,
  IncomingMessage,
  Logger,
  PollVote,
  WhatsAppCredentials,
} from './types.js';
import { resolveConfig, type ResolvedGatewayConfig } from './config.js';
import { createAuthStore, type AuthStore } from './auth/auth-state.js';
import { MessageStore, messageStoreKey } from './messages/message-store.js';
import {
  reduceConnection,
  initialConnectionState,
  type ConnectionEvent,
  type ConnectionReducerState,
} from './connection/connection-state.js';
import { nextBackoffDelayMs } from './connection/reconnect-policy.js';

// Structural mirror of Baileys' internal ILogger (not exported from the package root).
// makeWASocket accepts any object of this shape (structural typing); defining it here keeps
// us off the package internals while still typing the adapter precisely.
interface BaileysLogger {
  level: string;
  child(obj: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

type QRHandler = (qr: string) => void;
type ConnectionChangeHandler = (status: ConnectionStatus) => void;
type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;
type PollVoteHandler = (vote: PollVote) => void | Promise<void>;

interface ConnectWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class WhatsAppGateway {
  private readonly config: ResolvedGatewayConfig;

  // Built ONCE per session and reused across socket re-creation (C-2). Only forceReauth()
  // clears it. The socket, by contrast, is recreated on every restart/recover reconnect.
  private readonly authStore: AuthStore;
  private readonly messageStore = new MessageStore();
  private readonly baileysLogger: BaileysLogger;

  private sock: WASocket | undefined;
  private reducerState: ConnectionReducerState = initialConnectionState();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // connect() resolves once 'connected'; multiple concurrent callers share one attempt.
  private connectWaiters: ConnectWaiter[] = [];
  private connecting = false;

  private readonly qrHandlers: QRHandler[] = [];
  private readonly connectionChangeHandlers: ConnectionChangeHandler[] = [];
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly pollVoteHandlers: PollVoteHandler[] = [];

  constructor(config: GatewayConfig) {
    // resolveConfig validates consumer input (throws on a bad authorizedGroups) + applies defaults.
    this.config = resolveConfig(config);
    this.baileysLogger = this.createBaileysLogger(this.config.logger);
    // One-per-session auth store (C-2). Resumes from config.credentials if provided.
    this.authStore = createAuthStore({
      credentials: this.config.credentials,
      onCredentialsUpdate: this.config.onCredentialsUpdate,
      logger: this.config.logger,
    });
    this.config.logger.debug('WhatsAppGateway constructed', {
      authorizedGroups: this.config.authorizedGroups.length,
      minMessageDelayMs: this.config.minMessageDelayMs,
      resuming: this.config.credentials !== undefined,
    });
  }

  // ── Status ────────────────────────────────────────────────────────────────────────
  status(): ConnectionStatus {
    return this.reducerState.status;
  }

  isConnected(): boolean {
    return this.reducerState.status === 'connected';
  }

  // ── Connection / auth (US1) ─────────────────────────────────────────────────────---
  /**
   * Open the connection and resolve once `connected`. Emits `onQR` when a fresh pairing is
   * needed, transparently absorbs the post-pairing 515 handshake (bounded by
   * `maxRestartHandshakes`), auto-reconnects recoverable closes on backoff, and rejects on
   * a terminal close that occurs before we ever connect.
   */
  connect(): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
    });
    if (!this.connecting) {
      this.connecting = true;
      this.openSocket();
    }
    return promise;
  }

  /** Graceful close (no logout). Stays disconnected — does NOT auto-reconnect (H-1). */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    // Raise the intentional-close flag BEFORE tearing down so any trailing close is ignored.
    this.applyEvent({ type: 'intentional-disconnect' });
    this.teardownSocket();
    this.failConnectWaiters(
      new Error('WhatsAppGateway: disconnect() called before connect completed')
    );
    this.config.logger.info('WhatsAppGateway: disconnected');
  }

  /**
   * Best-effort logout + clear in-memory credentials (FR-007). The consumer then discards
   * its stored snapshot so the next connect() QR-pairs fresh. Establishes the flag before
   * logging out so the logout-induced close does not schedule a reconnect.
   */
  async forceReauth(): Promise<void> {
    this.clearReconnectTimer();
    this.applyEvent({ type: 'intentional-disconnect' });
    try {
      // A real best-effort logout requires a live socket (FR-007); skip silently if down.
      await this.sock?.logout();
    } catch (err) {
      this.config.logger.debug(
        'WhatsAppGateway: logout during forceReauth failed (continuing)',
        err
      );
    }
    this.teardownSocket();
    this.authStore.clear();
    this.failConnectWaiters(new Error('WhatsAppGateway: forceReauth() called'));
    this.config.logger.info('WhatsAppGateway: forced re-auth — in-memory credentials cleared');
  }

  /** Current live credential snapshot (e.g. to persist on shutdown). Never the stale input. */
  getCredentials(): WhatsAppCredentials | null {
    return this.authStore.serialize();
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────────---
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

  // ── Socket lifecycle (private) ──────────────────────────────────────────────────---
  /**
   * Create a fresh socket from the LIVE auth store (C-2: never rebuild the auth store here)
   * and wire its events. Always tears down any previous socket first (M-2: no leak).
   */
  private openSocket(): void {
    this.teardownSocket();

    const sock = makeWASocket({
      auth: this.authStore.state,
      logger: this.baileysLogger,
      browser: Browsers.macOS('Chrome'),
      // A bot should not steal notifications from the phone.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Back send-retries from the bounded in-memory store; a miss returns undefined.
      getMessage: async (key) =>
        this.messageStore.getMessage(messageStoreKey(key.remoteJid, key.id)),
    });
    this.sock = sock;

    sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
    // creds.update funnels through the auth store's single emit path (C-1).
    sock.ev.on('creds.update', () => this.authStore.emitUpdate());
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrHandlers.forEach((handler) => handler(qr));
    }

    if (connection === 'connecting') {
      this.applyEvent({ type: 'connecting' });
    } else if (connection === 'open') {
      this.applyEvent({ type: 'open' });
    } else if (connection === 'close') {
      const statusCode = extractStatusCode(lastDisconnect?.error);
      this.applyEvent({ type: 'close', statusCode }, lastDisconnect?.error, statusCode);
    }
  }

  /** Drive one event through the pure reducer and act on its decision. */
  private applyEvent(event: ConnectionEvent, error?: unknown, statusCode?: number): void {
    const previousStatus = this.reducerState.status;
    const { state, action } = reduceConnection(this.reducerState, event, {
      maxRestartHandshakes: this.config.maxRestartHandshakes,
      maxRecoverAttempts: this.config.reconnect.maxAttempts,
    });
    this.reducerState = state;

    if (state.status !== previousStatus) {
      this.connectionChangeHandlers.forEach((handler) => handler(state.status));
    }

    switch (action) {
      case 'connected':
        this.clearReconnectTimer();
        this.config.logger.info('WhatsAppGateway: connected');
        this.resolveConnectWaiters();
        break;

      case 'restart':
        // Expected post-pairing 515 handshake: recreate the socket immediately, same creds.
        this.config.logger.debug('WhatsAppGateway: absorbing 515 restart handshake', {
          handshake: state.restartHandshakes,
        });
        this.reopenAfter(0);
        break;

      case 'recover': {
        const delayMs = nextBackoffDelayMs(state.recoverAttempts, this.config.reconnect);
        this.config.logger.info('WhatsAppGateway: connection lost — scheduling reconnect', {
          attempt: state.recoverAttempts,
          delayMs: Math.round(delayMs),
          statusCode,
        });
        this.reopenAfter(delayMs);
        break;
      }

      case 'terminal':
        this.clearReconnectTimer();
        this.teardownSocket();
        this.config.logger.error('WhatsAppGateway: terminal disconnect — not reconnecting', {
          statusCode,
        });
        this.failConnectWaiters(
          error instanceof Error
            ? error
            : new Error(
                `WhatsAppGateway: terminal disconnect (statusCode: ${statusCode ?? 'unknown'})`
              )
        );
        break;

      case 'none':
        break;
    }
  }

  private reopenAfter(delayMs: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** Remove our listeners and close the previous socket so it can't leak or reconnect (M-2). */
  private teardownSocket(): void {
    if (!this.sock) {
      return;
    }
    const sock = this.sock;
    this.sock = undefined;
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
    } catch (err) {
      this.config.logger.debug('WhatsAppGateway: error removing socket listeners', err);
    }
    try {
      sock.end(undefined);
    } catch (err) {
      this.config.logger.debug('WhatsAppGateway: error ending socket', err);
    }
  }

  private resolveConnectWaiters(): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    this.connecting = false;
    waiters.forEach((waiter) => waiter.resolve());
  }

  private failConnectWaiters(error: Error): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    this.connecting = false;
    waiters.forEach((waiter) => waiter.reject(error));
  }

  /**
   * Adapt the consumer's domain Logger to Baileys' ILogger. Baileys is chatty at
   * trace/debug; we forward at matching levels and (FR-030) downgrade benign offline-sync
   * `MessageCounterError` replay noise from error → debug so it never looks like a fault.
   */
  private createBaileysLogger(logger: Logger): BaileysLogger {
    const isBenignReplayNoise = (obj: unknown, msg?: string): boolean => {
      const named = obj as { name?: string; message?: string } | undefined;
      const haystack = `${msg ?? ''} ${named?.name ?? ''} ${named?.message ?? ''}`;
      return haystack.includes('MessageCounterError');
    };
    const adapter: BaileysLogger = {
      level: 'debug',
      child: () => adapter,
      trace: () => {},
      debug: (obj, msg) => logger.debug(msg ?? '', obj),
      info: (obj, msg) => logger.info(msg ?? '', obj),
      warn: (obj, msg) => logger.warn(msg ?? '', obj),
      error: (obj, msg) => {
        if (isBenignReplayNoise(obj, msg)) {
          logger.debug(
            'WhatsAppGateway: benign offline-sync replay noise (MessageCounterError)',
            obj
          );
          return;
        }
        logger.error(msg ?? '', obj);
      },
    };
    return adapter;
  }
}

/** Pull the Baileys/Boom status code off a close error without importing @hapi/boom. */
function extractStatusCode(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}
