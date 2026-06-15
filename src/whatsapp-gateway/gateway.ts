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
import makeWASocket, {
  Browsers,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import type {
  ConnectionState,
  MessageUpsertType,
  WAMessage,
  WAMessageKey,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import type {
  ConnectionStatus,
  GatewayConfig,
  GroupSummary,
  IncomingMessage,
  Logger,
  MessageRef,
  PollKeyset,
  PollSendResult,
  PollSpec,
  PollVote,
  WhatsAppCredentials,
} from './types.js';
import { validatePollSpec } from './polls/poll-options.js';
import { decryptVote } from './polls/poll-vote-decryptor.js';
import { resolveConfig, type ResolvedGatewayConfig } from './config.js';
import { requireConnected } from './connection/require-connected.js';
import { createAuthStore, type AuthStore } from './auth/auth-state.js';
import { MessageStore, messageStoreKey } from './messages/message-store.js';
import { GroupFilter } from './groups/group-filter.js';
import { IdentityResolver } from './identity/identity-resolver.js';
import { RateLimiter } from './rate-limiter.js';
import { isNewInbound, mapIncomingMessage, normalizeTimestamp } from './messages/message-mapper.js';
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

  // US2 collaborators (pure units): authorized-group gate, canonical-identity resolver
  // (one per session so learned LID↔PN pairings accumulate), and the send rate limiter.
  private readonly groupFilter: GroupFilter;
  private readonly identityResolver = new IdentityResolver();
  private readonly sendLimiter: RateLimiter;

  private sock: WASocket | undefined;
  private reducerState: ConnectionReducerState = initialConnectionState();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // US3 poll state (in-session only; never persisted). Resolved poll secrets+options keyed
  // by `${groupId}:${pollId}` so repeat votes skip the consumer round-trip; learned group
  // addressing modes to order the #2342 creator try-both. Both empty after a restart — the
  // consumer's keyset (resolvePollKeyset) is the durable, restart-proof source.
  private readonly resolvedKeysets = new Map<string, { secret: Uint8Array; options: string[] }>();
  private readonly groupAddressingMode = new Map<string, 'pn' | 'lid'>();

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
    this.groupFilter = new GroupFilter(this.config.authorizedGroups);
    this.sendLimiter = new RateLimiter({ minDelay: this.config.minMessageDelayMs });
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

  // ── Groups (US4) ────────────────────────────────────────────────────────────────---
  /**
   * List every group the account participates in (FR-019). Returns `id`, `name`
   * (the group `subject`) and `addressingMode` (`'pn'`/`'lid'`, surfaced so the consumer
   * knows whether a group is LID-addressed — it affects poll-vote attribution). Returns an
   * empty array when the account is in no groups. Guards via `requireConnected`.
   *
   * Backed by Baileys' `groupFetchAllParticipating()`, which returns a JID-keyed map of
   * `GroupMetadata`; we project only the public fields so no Baileys type leaks out (FR-003).
   */
  async listGroups(): Promise<GroupSummary[]> {
    requireConnected(this.reducerState.status);
    // requireConnected guarantees we are 'connected', which only happens with a live socket.
    if (!this.sock) {
      throw new Error('WhatsAppGateway: no active socket while connected (unexpected)');
    }
    const participating = await this.sock.groupFetchAllParticipating();
    return Object.values(participating).map((metadata) => {
      // The enum's runtime values are exactly 'pn' | 'lid'; narrow to the public union.
      const addressingMode = metadata.addressingMode as GroupSummary['addressingMode'];
      // Seed the addressing-mode cache so poll-vote handling can order the creator try-both
      // without an extra metadata fetch (C-3).
      if (addressingMode) {
        this.groupAddressingMode.set(metadata.id, addressingMode);
      }
      return { id: metadata.id, name: metadata.subject, addressingMode };
    });
  }

  // ── Messaging (US2) ─────────────────────────────────────────────────────────────---
  /**
   * Send a plain text message to a group (FR-013). Rate-limited (≤5 msg/min, FR-016) and
   * guarded — rejects with a clear error unless `status() === 'connected'`. The sent message
   * is cached in the in-memory store so Baileys can re-deliver it on a retry-receipt (§2).
   * Returns a {@link MessageRef} sufficient to later `deleteMessage`.
   *
   * Verified against research.md §send: `sock.sendMessage(jid, { text })` →
   * `Promise<WAMessage | undefined>` (the `undefined` is handled).
   */
  async sendMessage(groupId: string, text: string): Promise<MessageRef> {
    requireConnected(this.reducerState.status);
    // requireConnected guarantees 'connected', which only holds with a live socket.
    if (!this.sock) {
      throw new Error('WhatsAppGateway: no active socket while connected (unexpected)');
    }
    const sock = this.sock;
    const sent = await this.sendLimiter.execute(() => sock.sendMessage(groupId, { text }));
    if (!sent?.key?.id) {
      throw new Error('WhatsAppGateway: sendMessage returned no usable message reference');
    }
    // Cache the outbound message for getMessage send-retries (§2).
    this.messageStore.set(sent);
    return { id: sent.key.id, groupId };
  }

  // ── Polls (US3) ─────────────────────────────────────────────────────────────────---
  /**
   * Post a native single-choice poll to a group and return both a {@link MessageRef} and the
   * {@link PollKeyset} the consumer MUST persist to decrypt later votes (FR-020/FR-021).
   * Guards via `requireConnected`; rate-limited (≤5 msg/min, FR-016); validates 2–12 non-empty
   * options first. Always sends `selectableCount: 1` — multi-select is out of scope.
   *
   * Verified against installed 7.0.0-rc13 (FR-031): `sock.sendMessage(jid, { poll: { name,
   * values, selectableCount } })` returns a `WAMessage` whose `message.messageContextInfo
   * .messageSecret` is the 32-byte secret for this poll's votes (lib/Utils/messages.js poll
   * branch). A single-choice poll is stored as `pollCreationMessageV3`.
   */
  async sendPoll(groupId: string, poll: PollSpec): Promise<PollSendResult> {
    requireConnected(this.reducerState.status);
    if (!this.sock) {
      throw new Error('WhatsAppGateway: no active socket while connected (unexpected)');
    }
    // Validate consumer input that TypeScript cannot enforce (2–12 non-empty options, FR-020).
    validatePollSpec(poll);
    const sock = this.sock;
    const sent = await this.sendLimiter.execute(() =>
      sock.sendMessage(groupId, {
        poll: { name: poll.question, values: poll.options, selectableCount: 1 },
      })
    );
    if (!sent?.key?.id) {
      throw new Error('WhatsAppGateway: sendPoll returned no usable message reference');
    }
    const secret = sent.message?.messageContextInfo?.messageSecret;
    if (!secret) {
      throw new Error('WhatsAppGateway: sendPoll — no messageSecret on the returned poll message');
    }
    const pollId = sent.key.id;
    // Cache the poll-creation message (backs getMessage + the in-session poll-secret fast-path).
    this.messageStore.set(sent);
    const secretBytes = toBytes(secret);
    // Seed the in-session secret cache so our own poll's votes decrypt with no consumer round-trip.
    this.resolvedKeysets.set(messageStoreKey(groupId, pollId), {
      secret: secretBytes,
      options: poll.options,
    });
    const keyset: PollKeyset = {
      pollId,
      groupId,
      messageSecret: Buffer.from(secretBytes).toString('base64'),
      options: poll.options,
    };
    this.config.logger.info('WhatsAppGateway: poll sent', { pollId, options: poll.options.length });
    return { ref: { id: pollId, groupId }, keyset };
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
    sock.ev.on('messages.upsert', (upsert) => this.handleMessagesUpsert(upsert));
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

  /**
   * Handle a `messages.upsert` batch (US2, FR-014/FR-015/FR-017). Per the official Baileys
   * docs the payload is `{ type: 'notify' | 'append', messages: WAMessage[] }` and the array
   * must be iterated in full. Every message (any type) is cached so `getMessage` can serve
   * send-retries and the later poll-secret fast-path (§2/§7); only live `'notify'` events
   * from an authorized group are mapped and dispatched (including the operator's own manual
   * messages — the linked account is a participant; `'append'` history/echo is excluded).
   */
  private handleMessagesUpsert(upsert: { messages: WAMessage[]; type: MessageUpsertType }): void {
    const { messages, type } = upsert;
    this.config.logger.debug('WhatsAppGateway: messages.upsert received', {
      type,
      count: messages.length,
    });
    for (const msg of messages) {
      // Cache first, unconditionally — append/echo/other-chat messages still back getMessage.
      this.messageStore.set(msg);

      const remoteJid = msg.key?.remoteJid ?? undefined;
      const fromMe = msg.key?.fromMe === true;
      const newInbound = isNewInbound(type, msg);
      const authorized = this.groupFilter.isAuthorized(remoteJid);
      this.config.logger.debug('WhatsAppGateway: upsert item', {
        id: msg.key?.id,
        remoteJid,
        participant: msg.key?.participant ?? undefined,
        fromMe,
        type,
        newInbound,
        authorized,
        isPollVote: msg.message?.pollUpdateMessage != null,
      });

      // SINGLE authorization chokepoint (FR-017/SC-004): only a live ('notify') message from an
      // authorized chat proceeds past here. EVERY downstream path — text dispatch AND poll-vote
      // handling — trusts this gate, so the zero-leakage invariant is enforced in exactly one
      // place. A poll vote always arrives in the poll's own chat, so `msg.key.remoteJid` is that
      // group (handlePollUpdate still derives the PollRef's groupId from the poll-creation key,
      // per research §11, but no longer re-filters).
      if (!newInbound) {
        this.config.logger.debug('WhatsAppGateway: skipping non-live item', {
          reason: `type=${type} (only 'notify' is live; 'append' = history / own programmatic-send echo)`,
        });
        continue;
      }
      if (!authorized) {
        // cross-chat leakage prevention (FR-017): ignore DMs/other groups/broadcast. The most
        // common cause of "listen prints nothing" is a configured authorizedGroups JID that
        // does not exactly match this remoteJid — both are logged above to spot the mismatch.
        this.config.logger.debug('WhatsAppGateway: dropping message from unauthorized chat', {
          remoteJid,
          authorizedGroups: this.config.authorizedGroups,
        });
        continue;
      }

      // Route an authorized, live message. Poll votes decrypt → onPollVote (never onMessage
      // text dispatch, US3/FR-022); everything else maps → onMessage.
      if (msg.message?.pollUpdateMessage) {
        void this.handlePollUpdate(msg);
        continue;
      }

      const incoming = mapIncomingMessage(msg, this.identityResolver);
      this.config.logger.debug('WhatsAppGateway: dispatching inbound message', {
        groupId: incoming.groupId,
        sender: incoming.sender.canonicalId,
        hasText: incoming.text !== null,
        handlers: this.messageHandlers.length,
      });
      this.dispatchMessage(incoming);
    }
  }

  /** Fan an inbound message out to subscribers; a handler that throws/rejects can't break us. */
  private dispatchMessage(message: IncomingMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        const result = handler(message);
        if (result instanceof Promise) {
          result.catch((err) =>
            this.config.logger.error('WhatsAppGateway: onMessage handler rejected', err)
          );
        }
      } catch (err) {
        this.config.logger.error('WhatsAppGateway: onMessage handler threw', err);
      }
    }
  }

  /**
   * Handle one raw `pollUpdateMessage` (US3, FR-021–FR-024; research.md §7). The caller
   * (`handleMessagesUpsert`) has already enforced the live + authorized-group gate, so this is
   * reached only for a live vote in an authorized chat — it does NOT re-filter (the single
   * authorization chokepoint lives in the caller). rc13 ships no in-core vote decryption, so we
   * do it ourselves: derive the poll's group+id from the `pollCreationMessageKey` (research §11),
   * resolve the secret+options (in-session store first, else `resolvePollKeyset`; neither ⇒ skip,
   * no error), decrypt with the #2342 creator try-both, canonicalize the voter, and emit a
   * per-voter `PollVote`. Never throws — any failure is logged and the vote is skipped.
   */
  private async handlePollUpdate(msg: WAMessage): Promise<void> {
    try {
      const pollUpdate = msg.message?.pollUpdateMessage;
      if (!pollUpdate) {
        return;
      }
      const creationKey = pollUpdate.pollCreationMessageKey;
      // The PollRef's group is the poll-creation message's chat (research §11); for a vote this
      // is the same chat the caller already authorized (`msg.key.remoteJid`), with a fallback.
      const groupId = creationKey?.remoteJid ?? msg.key?.remoteJid ?? undefined;
      const pollId = creationKey?.id ?? undefined;
      const encVote = pollUpdate.vote ?? undefined;
      if (!groupId || !pollId || !encVote) {
        this.config.logger.debug('WhatsAppGateway: poll update missing group/id/vote — skipping');
        return;
      }

      const resolved = await this.resolvePollSecret(groupId, pollId);
      if (!resolved) {
        this.config.logger.debug(
          'WhatsAppGateway: no keyset for poll (not cached and resolvePollKeyset gave none) — skipping vote',
          { pollId, groupId }
        );
        return;
      }

      await this.ensureAddressingMode(groupId);
      const creatorCandidates = this.pollCreatorCandidates(creationKey, groupId);
      const voterCandidates = this.pollVoterCandidates(msg.key, groupId);

      // Diagnostic snapshot of every JID form in play — the raw forms WhatsApp delivered plus the
      // exact values we feed `decryptPollVote`. Logged before the attempt (debug) and again on
      // failure (warn) so a decrypt failure is debuggable without re-running. (See research §7 /
      // #1678 / #2342: the sign + GCM AAD mix BOTH creator and voter JIDs, so a form mismatch on
      // either side fails the auth tag.)
      const forms = {
        pollId,
        groupId,
        addressingMode: this.groupAddressingMode.get(groupId) ?? 'unknown',
        // What we PASS to decryptPollVote (the full creator × voter matrix is tried):
        creatorCandidates,
        voterCandidates,
        // RAW forms from the vote's own message key:
        voteFromMe: msg.key?.fromMe === true,
        voteParticipant: msg.key?.participant ?? undefined,
        voteParticipantAlt: msg.key?.participantAlt ?? undefined,
        voteRemoteJid: msg.key?.remoteJid ?? undefined,
        // RAW forms from the poll-creation message key (the creator/our own poll):
        creationFromMe: creationKey?.fromMe === true,
        creationParticipant: creationKey?.participant ?? undefined,
        // Our own account's identity forms (creator side when fromMe):
        selfId: this.sock?.user?.id ?? undefined,
        selfLid: this.sock?.user?.lid ?? undefined,
        selfPhoneNumber: this.sock?.user?.phoneNumber ?? undefined,
      };

      if (voterCandidates.length === 0 || creatorCandidates.length === 0) {
        this.config.logger.warn(
          'WhatsAppGateway: cannot resolve poll voter/creator — skipping',
          forms
        );
        return;
      }

      this.config.logger.debug('WhatsAppGateway: attempting poll-vote decrypt', forms);

      const selectedOptions = decryptVote({
        vote: encVote,
        pollMsgId: pollId,
        voterCandidates,
        creatorCandidates,
        pollEncKey: resolved.secret,
        options: resolved.options,
      });
      if (selectedOptions === null) {
        // Mirrors Baileys' own "failed to decrypt poll vote" warning, but non-fatal (FR-021).
        // Logged at warn WITH the full form snapshot so the LID/PN mismatch is visible — compare
        // `voterJid`/`creatorCandidates` (what we tried) against the raw vote* forms (what arrived).
        this.config.logger.warn('WhatsAppGateway: failed to decrypt poll vote — skipping', forms);
        return;
      }

      const voter = this.identityResolver.resolve(
        msg.key?.participant ?? msg.key?.remoteJid ?? '',
        msg.key?.participantAlt ?? undefined,
        msg.pushName ?? undefined
      );
      const vote: PollVote = {
        pollId,
        groupId,
        voter,
        selectedOptions,
        timestamp: pollVoteTimestamp(pollUpdate, msg),
      };
      this.config.logger.debug('WhatsAppGateway: dispatching poll vote', {
        pollId,
        voter: voter.canonicalId,
        selectedOptions,
      });
      this.dispatchPollVote(vote);
    } catch (err) {
      this.config.logger.error('WhatsAppGateway: error handling poll update (skipping)', err);
    }
  }

  /**
   * Resolve a poll's decryption secret + option names. First-choice is the in-session message
   * store (the cached poll-creation message), then the consumer's `resolvePollKeyset` (the
   * durable, restart-proof fallback). Resolved keysets are cached in-session. Returns
   * `undefined` when neither source yields it (the vote is skipped, no error — FR-021).
   */
  private async resolvePollSecret(
    groupId: string,
    pollId: string
  ): Promise<{ secret: Uint8Array; options: string[] } | undefined> {
    const cacheKey = messageStoreKey(groupId, pollId);
    const cached = this.resolvedKeysets.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 1. In-session fast path: the poll-creation message is still cached this session.
    const creation = this.messageStore.getByPollId(groupId, pollId);
    if (creation) {
      const secret = creation.message?.messageContextInfo?.messageSecret;
      const options = pollOptionNames(creation);
      if (secret && options.length > 0) {
        const resolved = { secret: toBytes(secret), options };
        this.resolvedKeysets.set(cacheKey, resolved);
        return resolved;
      }
    }

    // 2. Durable fallback: ask the consumer for the persisted keyset.
    if (this.config.resolvePollKeyset) {
      try {
        const keyset = await this.config.resolvePollKeyset({ pollId, groupId });
        if (keyset) {
          const resolved = {
            secret: new Uint8Array(Buffer.from(keyset.messageSecret, 'base64')),
            options: keyset.options,
          };
          this.resolvedKeysets.set(cacheKey, resolved);
          return resolved;
        }
      } catch (err) {
        this.config.logger.debug('WhatsAppGateway: resolvePollKeyset threw — skipping vote', err);
      }
    }
    return undefined;
  }

  /** Lazily fetch + cache a group's addressing mode (drives the creator try-both order, C-3). */
  private async ensureAddressingMode(groupId: string): Promise<void> {
    if (this.groupAddressingMode.has(groupId) || !this.sock) {
      return;
    }
    try {
      const metadata = await this.sock.groupMetadata(groupId);
      if (metadata.addressingMode) {
        this.groupAddressingMode.set(groupId, metadata.addressingMode as 'pn' | 'lid');
      }
    } catch (err) {
      this.config.logger.debug('WhatsAppGateway: could not fetch group addressingMode', err);
    }
  }

  /**
   * Build the ordered creator-JID candidates for the #2342 try-both (C-3). For a poll WE
   * created (`fromMe`), both our own LID and PN forms are returned — LID-first in a LID group,
   * PN-first otherwise — so the decryptor makes genuinely distinct attempts. For someone
   * else's poll, the creator is the message author.
   */
  private pollCreatorCandidates(
    creationKey: WAMessageKey | null | undefined,
    groupId: string
  ): string[] {
    if (creationKey?.fromMe && this.sock?.user) {
      const user = this.sock.user;
      const lid = user.lid ? jidNormalizedUser(user.lid) : undefined;
      const pn = user.phoneNumber
        ? jidNormalizedUser(user.phoneNumber)
        : user.id
          ? jidNormalizedUser(user.id)
          : undefined;
      const mode = this.groupAddressingMode.get(groupId);
      // Pass BOTH forms regardless (the try-both must run); mode only chooses which to try first.
      const ordered = mode === 'pn' ? [pn, lid] : [lid, pn];
      return uniqueDefined(ordered);
    }
    const author =
      creationKey?.participant ??
      creationKey?.participantAlt ??
      creationKey?.remoteJid ??
      undefined;
    return author ? [jidNormalizedUser(author)] : [];
  }

  /**
   * Build the ordered voter-JID candidates for the decrypt matrix. A LID-addressed group encrypts
   * the vote under the voter's **LID** form, a PN group under **PN** (observed against a real LID
   * group — the working vote used voter=LID; a PN-only attempt fails). So we pass BOTH the voter's
   * LID and PN forms, LID-first in a LID group, plus the raw participant and (for our own vote)
   * our own forms as fallbacks. The decryptor tries each until the auth tag accepts one.
   */
  private pollVoterCandidates(key: WAMessageKey | null | undefined, groupId: string): string[] {
    const participant = key?.participant ?? undefined;
    const alt = key?.participantAlt ?? undefined;
    const lid = [participant, alt].find((jid) => jid && isLidUser(jid));
    const pn = [participant, alt].find((jid) => jid && isPnUser(jid));
    const mode = this.groupAddressingMode.get(groupId);
    const ordered: Array<string | undefined> = mode === 'pn' ? [pn, lid] : [lid, pn];
    // Raw forms as fallbacks (covers anything not classified as PN/LID).
    ordered.push(participant, alt);
    // Our own vote: getKeyAuthor resolves a fromMe author to our own id, so include our forms.
    if (key?.fromMe && this.sock?.user) {
      const user = this.sock.user;
      ordered.push(user.lid ?? undefined, user.phoneNumber ?? user.id ?? undefined);
    }
    return uniqueDefined(ordered.map((jid) => (jid ? jidNormalizedUser(jid) : undefined)));
  }

  /** Fan a decoded vote out to subscribers; a handler that throws/rejects can't break us. */
  private dispatchPollVote(vote: PollVote): void {
    for (const handler of this.pollVoteHandlers) {
      try {
        const result = handler(vote);
        if (result instanceof Promise) {
          result.catch((err) =>
            this.config.logger.error('WhatsAppGateway: onPollVote handler rejected', err)
          );
        }
      } catch (err) {
        this.config.logger.error('WhatsAppGateway: onPollVote handler threw', err);
      }
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
      sock.ev.removeAllListeners('messages.upsert');
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

/** Coerce a Baileys secret (`Uint8Array`, possibly a `Buffer`) to a plain `Uint8Array`. */
function toBytes(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Drop `undefined`s and duplicates while preserving order. */
function uniqueDefined(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Read a poll's option names from its cached creation message. A single-choice poll is stored
 * as `pollCreationMessageV3` in rc13; older/multi/announcement variants use
 * `pollCreationMessage`/`V2` — check all three (verified against installed
 * `getAggregateVotesInPollMessage`, FR-031).
 */
function pollOptionNames(creation: WAMessage): string[] {
  const content = creation.message;
  const poll =
    content?.pollCreationMessage ??
    content?.pollCreationMessageV2 ??
    content?.pollCreationMessageV3;
  return (poll?.options ?? []).map((opt) => opt.optionName ?? '');
}

/**
 * Timestamp for a vote: prefer the vote's own `senderTimestampMs` (ms), else fall back to the
 * carrier message's `messageTimestamp` (seconds).
 */
function pollVoteTimestamp(pollUpdate: proto.Message.IPollUpdateMessage, msg: WAMessage): Date {
  const ms = pollUpdate.senderTimestampMs;
  if (ms != null) {
    const asNumber = typeof ms === 'number' ? ms : (ms as { toNumber?: () => number }).toNumber?.();
    if (typeof asNumber === 'number' && Number.isFinite(asNumber)) {
      return new Date(asNumber);
    }
  }
  return normalizeTimestamp(msg.messageTimestamp);
}
