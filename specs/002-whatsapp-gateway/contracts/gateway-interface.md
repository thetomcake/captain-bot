# Contract: WhatsApp Gateway Public Interface

This is the **entire surface** the Gateway exposes to a consumer (the MVP, later; the manual entry points, now). It hides all Baileys types (FR-003) and owns **no storage** — credentials and poll keysets are returned to the consumer to persist (FR-008, FR-021). Exported from `src/whatsapp-gateway/index.ts`. Signatures are the contract; bodies are implementation.

```typescript
// ── Construction ────────────────────────────────────────────────────────────
export interface GatewayConfig {
  authorizedGroups?: string[];         // optional (default []); group JIDs (…@g.us) to act in.
                                       // auth-only/discovery (connect/force-reauth/list-groups) need none;
                                       // group ops (receive/send/polls) require ≥1. Entries must be group JIDs.

  // Storage-agnostic credentials: the library persists NOTHING itself.
  credentials?: WhatsAppCredentials;   // opaque snapshot to resume from; omit ⇒ fresh QR pairing
  onCredentialsUpdate?: (creds: WhatsAppCredentials) => void | Promise<void>;
                                       // fired whenever credentials change — consumer persists them

  // Storage-agnostic poll decryption: consumer supplies a poll's keyset on demand.
  resolvePollKeyset?: (ref: PollRef) => PollKeyset | null | Promise<PollKeyset | null>;
                                       // fallback used only when the poll-creation message isn't in the
                                       // in-session store; return null ⇒ skip decryption for that vote (no error)

  minMessageDelayMs?: number;          // default 12000 (≤5 msg/min)
  maxRestartHandshakes?: number;       // default 5
  reconnect?: Partial<ReconnectPolicyConfig>;
  logger?: Logger;
}

export class WhatsAppGateway {
  constructor(config: GatewayConfig);

  // ── Connection / auth (US1) ────────────────────────────────────────────────
  connect(): Promise<void>;            // resolves once 'connected'; rejects on terminal close
  disconnect(): Promise<void>;         // graceful close (no logout)
  forceReauth(): Promise<void>;        // best-effort logout + clear in-memory creds; consumer then
                                       // discards its stored snapshot → next connect() QR-pairs fresh
  isConnected(): boolean;
  status(): ConnectionStatus;          // 'connecting'|'connected'|'closed'|'terminal'
  getCredentials(): WhatsAppCredentials | null;   // current snapshot on demand (e.g. persist on shutdown)

  // ── Groups (US4) ─────────────────────────────────────────────────────────-
  listGroups(): Promise<GroupSummary[]>;

  // ── Messaging (US2) ─────────────────────────────────────────────────────────
  sendMessage(groupId: string, text: string): Promise<MessageRef>;
  deleteMessage(ref: MessageRef): Promise<DeleteOutcome>;   // best-effort (US5)

  // ── Polls (US3) ─────────────────────────────────────────────────────────────
  sendPoll(groupId: string, poll: PollSpec): Promise<PollSendResult>;  // returns ref + keyset

  // ── Subscriptions ────────────────────────────────────────────────────────────
  onQR(handler: (qr: string) => void): void;
  onConnectionChange(handler: (status: ConnectionStatus) => void): void;
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;
  onPollVote(handler: (vote: PollVote) => void | Promise<void>): void;  // per-voter selection
}

// ── Optional pure helper (consumer-side aggregation) ──────────────────────────
/** Stateless: fold per-voter PollVote events into a per-option tally. Library keeps no tally. */
export function aggregateVotes(votes: PollVote[]): PollResult;

// ── Opaque credential snapshot (FR-008) ───────────────────────────────────────
/**
 * Opaque, JSON-serializable session snapshot. Treat as a black box:
 * persist verbatim and pass back via GatewayConfig.credentials.
 */
export type WhatsAppCredentials = string;

// ── Domain types (see data-model.md) ───────────────────────────────────────────
export type ConnectionStatus = 'connecting' | 'connected' | 'closed' | 'terminal';
export interface GroupSummary { id: string; name: string; addressingMode?: 'pn' | 'lid'; }
export interface MessageRef { id: string; groupId: string; }
export interface Identity { canonicalId: string; pn?: string; lid?: string; displayHint?: string; }
export interface IncomingMessage {
  id: string; groupId: string; sender: Identity;
  text: string | null; timestamp: Date; fromMe: boolean;
}

// Polls
export interface PollSpec { question: string; options: string[]; }  // single-choice; multi-select out of scope
export interface PollKeyset {            // returned by sendPoll; supplied back via resolvePollKeyset
  pollId: string; groupId: string;
  messageSecret: string;                 // base64 32-byte secret; persist verbatim
  options: string[];                     // option texts (to label decrypted selections)
}
export interface PollRef { pollId: string; groupId: string; }
export interface PollSendResult { ref: MessageRef; keyset: PollKeyset; }
export interface PollVote {               // one per-voter current selection (a delta)
  pollId: string; groupId: string;
  voter: Identity; selectedOptions: string[];   // [] = withdrawn
  timestamp: Date;
}
// Consumer-side aggregation output (from aggregateVotes; library never maintains it):
export interface PollOptionResult { name: string; voters: Identity[]; voteCount: number; }
export interface PollResult { pollId: string; options: PollOptionResult[]; }

export type DeleteOutcome =
  | { ok: true }
  | { ok: false; reason: 'window-expired' | 'not-found' | 'network' | 'unknown'; detail?: string };

export interface ReconnectPolicyConfig {
  baseDelayMs: number; maxDelayMs: number; factor: number; jitter: boolean; maxAttempts: number | null;
}
export interface Logger { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; }
```

## Behavioural contract (maps to FRs)

| Method / event | Guarantees |
|----------------|-----------|
| `connect()` | Emits `onQR` when no/expired session (FR-005); resolves only when truly `connected`; transparently absorbs the 515 post-pairing handshake bounded by `maxRestartHandshakes` (FR-010); auto-reconnects recoverable closes on backoff; rejects/`terminal` on non-recoverable (FR-011). |
| `onCredentialsUpdate` / `getCredentials()` | Library persists nothing. Hands the consumer an opaque snapshot on every credential change to store; consumer supplies it back via `config.credentials` to resume without a QR (FR-006, FR-008, FR-012). |
| `forceReauth()` | Best-effort logout, clears in-memory credentials; consumer discards its stored snapshot so the next `connect()` requires a fresh QR (FR-007). |
| `sendMessage` | Rate-limited (FR-016); rejects if not connected; returns a `MessageRef`. |
| `sendPoll` | Validates 2–12 options (FR-020); rejects if not connected; posts the poll **with a Gateway-generated `messageSecret`** and returns `{ ref, keyset }` — the consumer MUST store the `keyset` to decrypt later votes (FR-021). |
| `resolvePollKeyset` (consumer-supplied) | On each incoming vote, **if the poll-creation message is not in the Gateway's in-session message store**, the Gateway calls this with a `PollRef`; a returned keyset is used to decrypt; `null`/throw ⇒ that vote is **skipped without error** (FR-021). When the poll *is* still cached this session, the Gateway reads the secret from there and may not call the resolver. The keyset is the durable, restart-proof source; resolved keysets are cached in-memory for the session. |
| `onPollVote` | Fires once per successfully decrypted vote with the voter's canonical `Identity` and full current selection (FR-022); a change/withdrawal is the voter's new full selection / `[]` (FR-023); correct in LID groups (FR-024); no LID/PN double-identity (FR-026). The consumer aggregates (optionally via `aggregateVotes`). |
| `deleteMessage` | Best-effort revoke; **never throws** on WhatsApp rejection — returns `{ ok: false, reason }` (FR-028). |
| `listGroups` | All participating groups with name + id; empty array if none (FR-019). |
| `onMessage` | Fires for every live (`notify`) message from an authorized group — **including the operator's own manual messages** (the linked account is a participant; `fromMe` may be `true`). Never fires for `append` events (the Gateway's own programmatic-send echoes + history backfill) or other chats (FR-014/FR-015/FR-017). Consumers that must treat the operator's own messages differently branch on `IncomingMessage.fromMe`. |

## Invariants
- No Baileys type appears in any exported signature; `WhatsAppCredentials` is opaque.
- The library performs **no filesystem or database I/O**; all durable state (credentials, poll keysets, vote tally) is the consumer's, via `credentials`/`onCredentialsUpdate`/`getCredentials()`, `sendPoll` result + `resolvePollKeyset`, and consumer-side aggregation. (A bounded, ephemeral in-memory message store backs send-retries and an in-session poll-secret fast-path, but it is never persisted and survives no restart.)
- Every person in `IncomingMessage.sender` / `PollVote.voter` is a canonical `Identity` (FR-025).
- Operations that require a live socket reject clearly when `status() !== 'connected'`.
