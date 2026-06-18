// Public domain types for the WhatsApp Gateway library.
//
// INVARIANT (contracts/gateway-interface.md): no Baileys type may appear in this
// file or in index.ts. The gateway translates Baileys shapes into these at the
// boundary (FR-003). All identifiers are strings; timestamps are JS `Date`.

// ── Connection ────────────────────────────────────────────────────────────────

/** Lifecycle status surfaced to the consumer (FR-009). */
export type ConnectionStatus = 'connecting' | 'connected' | 'closed' | 'terminal';

// ── Credentials (opaque snapshot, FR-008) ───────────────────────────────────────

/**
 * Opaque, JSON-serializable session snapshot. Treat as a black box: persist
 * verbatim and pass back via {@link GatewayConfig.credentials}. The library
 * (de)serializes Baileys `creds` + signal `keys` into/out of this internally.
 */
export type WhatsAppCredentials = string;

// ── Groups ──────────────────────────────────────────────────────────────────--

/** Returned by `listGroups()` (FR-019). */
export interface GroupSummary {
  id: string;
  name: string;
  /** Surfaced so the consumer knows if the group is LID-addressed (affects vote attribution). */
  addressingMode?: 'pn' | 'lid';
}

// ── Identity ────────────────────────────────────────────────────────────────--

/** Canonical representation of a person, reconciling JID/LID/device forms (FR-025/FR-026). */
export interface Identity {
  /** Stable key used everywhere (prefers PN form when known; device suffix stripped). */
  canonicalId: string;
  /** Phone-number-form JID, if known. */
  pn?: string;
  /** LID-form JID, if known. */
  lid?: string;
  /** Best-effort human label (e.g. push name), optional. */
  displayHint?: string;
}

// ── Messages ──────────────────────────────────────────────────────────────────

/** Reported to `onMessage` for genuine inbound activity (FR-014). */
export interface IncomingMessage {
  id: string;
  groupId: string;
  sender: Identity;
  text: string | null;
  timestamp: Date;
  /** Who sent it; `true` for the operator's own messages. The linked account is a participant,
   *  so own messages ARE dispatched (FR-015). Branch on this to treat them differently. */
  fromMe: boolean;
}

/** Returned by `sendMessage`/`sendPoll` (FR-013/FR-020); sufficient to later `deleteMessage`. */
export interface MessageRef {
  id: string;
  groupId: string;
}

/**
 * Result of a best-effort revoke (FR-028). `{ ok: true }` means the revoke stanza was **sent**
 * (Baileys' revoke is fire-and-forget — WhatsApp does not confirm it), not that the message was
 * provably removed; an out-of-window or unknown-id revoke also yields `{ ok: true }`.
 *
 * Of the failure reasons, only `network` (transport drop mid-send) and `unknown` (encryption /
 * precondition fault) are produced today. `window-expired` and `not-found` are **reserved**: they
 * are not synchronously detectable because a revoke awaits no server ack, so the server-side
 * rejection never surfaces as a thrown error (verified vs baileys 7.0.0-rc13 — see
 * messages/delete-classifier.ts). They remain in the union for contract stability / forward-compat.
 */
export type DeleteOutcome =
  | { ok: true }
  | { ok: false; reason: 'window-expired' | 'not-found' | 'network' | 'unknown'; detail?: string };

/**
 * Result of a best-effort pin or unpin (007-auto-pin-poll, FR-001/FR-006). Never thrown — always
 * returned (mirrors {@link DeleteOutcome}). `{ ok: true }` means the (un)pin stanza was **sent**
 * (fire-and-forget — WhatsApp does not ack it), not proof of a server-side state change.
 * `reason: 'network'` is a transport drop mid-send; `reason: 'unknown'` an encryption / precondition
 * fault. The discrete pin-duration buckets stay below the Gateway seam (see messages/pin-duration.ts).
 */
export type PinOutcome =
  | { ok: true }
  | { ok: false; reason: 'network' | 'unknown'; detail?: string };

// ── Polls ───────────────────────────────────────────────────────────────────--

/** Input to `sendPoll`. Single-choice; multi-select is out of scope for now. */
export interface PollSpec {
  question: string;
  /** 2–12 entries, each non-empty (validated by poll-options.ts before send, FR-020). */
  options: string[];
}

/** Returned by `sendPoll`; supplied back via `resolvePollKeyset` (FR-021). */
export interface PollKeyset {
  pollId: string;
  groupId: string;
  /** Base64-encoded 32-byte secret used to decrypt this poll's votes. Persist verbatim. */
  messageSecret: string;
  /** Option texts — needed to label decrypted selections (vote payloads carry option hashes). */
  options: string[];
}

/** Input to `resolvePollKeyset` — tells the consumer which poll's keyset to return. */
export interface PollRef {
  pollId: string;
  groupId: string;
}

/** Returned by `sendPoll` (FR-020/FR-021). */
export interface PollSendResult {
  ref: MessageRef;
  keyset: PollKeyset;
}

/** Emitted by `onPollVote` — one per-voter current selection, a delta (FR-022/FR-023). */
export interface PollVote {
  pollId: string;
  groupId: string;
  /** Canonical voter (LID/PN reconciled). */
  voter: Identity;
  /** The voter's full current selection (option names); `[]` = withdrawn. */
  selectedOptions: string[];
  timestamp: Date;
}

/** Consumer-side aggregation output (from `aggregateVotes`; library never maintains it). */
export interface PollOptionResult {
  name: string;
  voters: Identity[];
  voteCount: number;
}

export interface PollResult {
  pollId: string;
  options: PollOptionResult[];
}

// ── Configuration ───────────────────────────────────────────────────────────--

export interface ReconnectPolicyConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
  /** `null` ⇒ retry recoverable closes indefinitely. */
  maxAttempts: number | null;
}

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

/** Input the consumer provides when constructing the Gateway. */
export interface GatewayConfig {
  /**
   * Group JIDs (`…@g.us`) this gateway may act in; inbound activity outside them is
   * ignored (FR-017). **Optional** — omit (or pass `[]`) for auth-only / group-discovery
   * use (`connect`, `force-reauth`, `list-groups`), which need no group. Any entry supplied
   * must be a group JID (FR-018). Group-dependent operations (inbound dispatch, send, polls)
   * require ≥1 entry and fail clearly when none is configured.
   */
  authorizedGroups?: string[];

  // Storage-agnostic credentials: the library persists NOTHING itself (FR-008).
  /** Opaque snapshot to resume from; omit ⇒ fresh QR pairing (FR-006). */
  credentials?: WhatsAppCredentials;
  /** Fired whenever credentials change so the consumer can persist them (FR-008/FR-012). */
  onCredentialsUpdate?: (creds: WhatsAppCredentials) => void | Promise<void>;

  // Storage-agnostic poll decryption: consumer supplies a poll's keyset on demand.
  /**
   * Fallback used only when the poll-creation message isn't in the in-session store;
   * return `null` ⇒ skip decryption for that vote (no error) (FR-021).
   */
  resolvePollKeyset?: (ref: PollRef) => PollKeyset | null | Promise<PollKeyset | null>;

  /** Default `12000` (≤5 msg/min, FR-016). */
  minMessageDelayMs?: number;
  /** Default `5` — bounds the post-pairing 515 handshake loop (FR-010). */
  maxRestartHandshakes?: number;
  /** Backoff schedule for recoverable closes (FR-011). */
  reconnect?: Partial<ReconnectPolicyConfig>;
  /** Optional; defaults to a no-op logger. */
  logger?: Logger;
}
