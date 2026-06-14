# Data Model: Standalone WhatsApp Gateway Library

These are the Gateway's **public domain types** and internal state structures. They deliberately contain **no Baileys types** — the wrapper translates Baileys shapes into these at the boundary (FR-003). All identifiers are strings; timestamps are JS `Date`.

> Types below are descriptive (TypeScript-shaped) to anchor the implementation; final field names live in `src/whatsapp-gateway/types.ts`.

---

## Configuration

### `GatewayConfig`
Input the consumer provides when constructing the Gateway.

| Field | Type | Rules |
|-------|------|-------|
| `authorizedGroups?` | `string[]` | Optional (default `[]`). Group JIDs (`…@g.us`) the gateway may act in; inbound activity outside them is ignored (FR-017). Auth-only / discovery use (`connect`, `force-reauth`, `list-groups`) needs none; group-dependent ops (inbound dispatch, send, polls) require ≥1. Any entry supplied must be a group JID (FR-018). |
| `credentials` | `WhatsAppCredentials \| undefined` | Opaque snapshot to resume from; omit ⇒ fresh QR pairing (FR-006, FR-008). |
| `onCredentialsUpdate` | `(creds: WhatsAppCredentials) => void \| Promise<void>` | Called when credentials change so the consumer can persist them; library stores nothing itself (FR-008, FR-012). |
| `resolvePollKeyset` | `(ref: PollRef) => PollKeyset \| null \| Promise<PollKeyset \| null>` | Called when a vote arrives so the consumer can supply that poll's keyset; `null` ⇒ skip decryption, no error (FR-021). |
| `minMessageDelayMs` | `number` | Default `12000` (≤5 msg/min, FR-016). |
| `maxRestartHandshakes` | `number` | Default `5` — bounds the post-pairing 515 loop (FR-010). |
| `reconnect` | `ReconnectPolicyConfig` | Backoff schedule for recoverable closes (FR-011). |
| `logger?` | `Logger` | Optional; defaults to a no-op/console logger. |

### `ReconnectPolicyConfig`
| Field | Type | Default |
|-------|------|---------|
| `baseDelayMs` | `number` | `1000` |
| `maxDelayMs` | `number` | `30000` |
| `factor` | `number` | `2` |
| `jitter` | `boolean` | `true` |
| `maxAttempts` | `number \| null` | `null` (retry recoverable closes indefinitely) |

---

## Session / Credentials

### `WhatsAppCredentials` (opaque snapshot)
An **opaque, JSON-serializable** snapshot of the session (Baileys `creds` + signal `keys`), produced and consumed only by the library. The consumer treats it as a black box: **persist it verbatim** (DB text column, file, secret store — their choice) and pass it back next time via `GatewayConfig.credentials`. The library (de)serializes it via `BufferJSON` and must round-trip all v7 key types incl. `lid-mapping`, `device-list`, `tctoken` (research.md §1).

The library owns **no storage** (FR-002, FR-008). Persistence is entirely consumer-side, driven by:
- `GatewayConfig.credentials?` — the snapshot to resume from (omit ⇒ fresh QR pairing).
- `GatewayConfig.onCredentialsUpdate?(snapshot)` — invoked whenever credentials change (pairing, `creds.update`, key writes) so the consumer can persist. May fire frequently; consumer may debounce (FR-012).
- `getCredentials(): WhatsAppCredentials | null` — current snapshot on demand (e.g., persist on shutdown).

**State transitions** (credentials live in the consumer's store; the library only mirrors them in memory):
- *none* → (first QR pairing) → *paired* (snapshot emitted via `onCredentialsUpdate`; consumer stores it)
- *paired* → (`creds.update` / key write) → *paired'* (new snapshot emitted; consumer overwrites, FR-012)
- *paired* → (`forceReauth()`) → *none* in memory; consumer **discards** its stored snapshot; next `connect()` QR-pairs fresh (FR-007)

A round-trip — `serialize(state)` → `deserialize(snapshot)` ≡ original `AuthenticationState` — is a pure function, unit-tested in `credentials.test.ts`.

---

## Connection

### `ConnectionStatus` (enum)
`'connecting' | 'connected' | 'closed' | 'terminal'` (FR-009).

- `connecting` — socket opening / awaiting QR scan.
- `connected` — open and usable.
- `closed` — recoverable disconnect; Gateway is retrying on backoff.
- `terminal` — non-recoverable (logged out / forbidden / multidevice mismatch / bad session); Gateway has stopped retrying.

### `DisconnectClass` (internal, from `disconnect-classifier.ts`)
`'restart' | 'recover' | 'terminal'` — derived purely from the Baileys status code (mapping in research.md §2). Note `408` is ambiguous (lost vs timedOut) and always classifies as `recover`.

**Connection state machine**:
```
connecting ──open──────────────► connected
connecting ──close:restart(515)─► connecting   (bounded by maxRestartHandshakes; exceed → terminal+error)
connected  ──close:recover──────► closed ──backoff──► connecting
connected  ──close:terminal─────► terminal   (stop; surface; may require forceReauth)
```

---

## Group

### `GroupSummary`
Returned by `listGroups()` (FR-019).

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Stable group JID (`…@g.us`). |
| `name` | `string` | Display name (Baileys `subject`). |
| `addressingMode?` | `'pn' \| 'lid'` | Surfaced so the operator/consumer knows if the group is LID-addressed (affects vote attribution). |

---

## Identity

### `Identity`
Canonical representation of a person, reconciling JID/LID/device forms (FR-025/FR-026).

| Field | Type | Notes |
|-------|------|-------|
| `canonicalId` | `string` | The stable key used everywhere (prefers PN form when known; device suffix stripped). |
| `pn?` | `string` | Phone-number-form JID, if known. |
| `lid?` | `string` | LID-form JID, if known. |
| `displayHint?` | `string` | Best-effort human label (e.g., push name), optional. |

**Rule**: two surface forms (`pn` and `lid`) for the same human resolve to one `canonicalId`; never emit the same person twice.

---

## Message

### `IncomingMessage` (reported to `onMessage`, FR-014)
| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Message reference (`key.id`). |
| `groupId` | `string` | Always an authorized group (others are filtered out). |
| `sender` | `Identity` | Canonical sender. |
| `text` | `string \| null` | From `conversation` or `extendedTextMessage.text`. |
| `timestamp` | `Date` | Normalized from `messageTimestamp`. |
| `fromMe` | `boolean` | Who sent it. `onMessage` fires for every live (`notify`) message, gated on `type`, **not** on `fromMe`; so this is `true` for the operator's own manual messages (the linked account is a participant). The Gateway's own programmatic sends + history backfill arrive as `append` and are never dispatched (FR-015). Consumers needing to treat own messages differently branch on this flag. |

### `MessageRef`
Returned by `sendMessage`/`sendPoll` (FR-013/FR-020): `{ id: string; groupId: string }`. Sufficient to later `deleteMessage`.

### `MessageStore` (internal, ephemeral)
A **bounded, in-memory** LRU cache of recently sent and received messages, keyed by `${remoteJid}:${id}`. Two jobs:
- Backs Baileys' `getMessage(key)` so our outbound messages/polls can be **re-sent on a retry-receipt** (research.md §2). A miss returns `undefined` (best-effort; empty after a restart).
- Serves as the **first-choice source of a poll's `messageSecret` + option names** when the poll-creation message is still cached this session — the Gateway reads `messageContextInfo.messageSecret` + `pollCreationMessage.options` directly, skipping the consumer round-trip. The consumer's `resolvePollKeyset` keyset is the **durable fallback** and the only path that survives a restart (research.md §7).

Never persisted; holds Baileys message objects internally but exposes none. It is **not** the consumer's durable store (FR-008) — durability remains the credential snapshot + poll keysets.

---

## Poll

### `PollSpec` (input to `sendPoll`)
| Field | Type | Rules |
|-------|------|-------|
| `question` | `string` | Non-empty. |
| `options` | `string[]` | **2–12** entries, each non-empty, validated by `poll-options.ts` before send (FR-020). Posted as a single-choice poll; multi-select is out of scope for now. |

### `PollKeyset` (returned by `sendPoll`; supplied back via `resolvePollKeyset`)
| Field | Type | Notes |
|-------|------|-------|
| `pollId` | `string` | Poll-creation message id. |
| `groupId` | `string` | Group the poll was posted to. |
| `messageSecret` | `string` | Base64-encoded 32-byte secret used to decrypt this poll's votes. Persist verbatim. |
| `options` | `string[]` | Option texts — needed to label decrypted selections (vote payloads carry option *hashes*, not names). |

The consumer stores the keyset (e.g. the MVP adds a `messageSecret` column alongside its existing poll/option rows) and returns it from `resolvePollKeyset` when a vote for that poll arrives. The Gateway persists none of it (FR-021).

### `PollRef` (input to `resolvePollKeyset`)
`{ pollId: string; groupId: string }` — tells the consumer which poll's keyset to return.

### `PollSendResult` (returned by `sendPoll`)
`{ ref: MessageRef; keyset: PollKeyset }` (FR-020/FR-021).

### `PollVote` (emitted by `onPollVote`, FR-022/FR-023)
| Field | Type | Notes |
|-------|------|-------|
| `pollId` | `string` | Which poll. |
| `groupId` | `string` | Authorized group. |
| `voter` | `Identity` | Canonical voter (LID/PN reconciled). |
| `selectedOptions` | `string[]` | The voter's **full current selection** (option names); `[]` = withdrawn. |
| `timestamp` | `Date` | When the vote was cast. |

Each `PollVote` is the voter's complete current selection and is applied by the consumer as a **replace-by-voter** update. The Gateway keeps **no durable tally** (FR-022).

### `PollResult` / `PollOptionResult` (consumer-side aggregation — optional pure helper)
The library does not maintain these, but exports a **pure, stateless** helper `aggregateVotes(votes: PollVote[]): PollResult` the consumer may use:
- `PollResult` = `{ pollId: string; options: PollOptionResult[] }`
- `PollOptionResult` = `{ name: string; voters: Identity[]; voteCount: number }`

Aggregation applies last-write-per-voter and identity canonicalization so LID/PN duplicates collapse.

---

## Events / callbacks exposed by the Gateway

| Event | Payload | Requirement |
|-------|---------|-------------|
| `onCredentialsUpdate(creds)` | opaque snapshot to persist (config callback, push) | FR-006/FR-008/FR-012 |
| `resolvePollKeyset(ref) → keyset \| null` | consumer supplies a poll's decryption keyset on demand — **fallback** when the poll-creation message isn't in the in-session store (config callback, pull) | FR-021 |
| `onQR(qr: string)` | raw QR string to render | FR-005 |
| `onConnectionChange(status: ConnectionStatus)` | lifecycle | FR-009 |
| `onMessage(msg: IncomingMessage)` | genuine inbound in an authorized group | FR-014/FR-015/FR-017 |
| `onPollVote(vote: PollVote)` | one decrypted per-voter selection; consumer aggregates | FR-022/FR-023 |

---

## Validation rules summary

- `authorizedGroups`: optional (default `[]`); every entry supplied must be a group JID (`isJidGroup`) (FR-018). Group-dependent operations (inbound dispatch, send, polls) require ≥1 and fail clearly when none is configured (FR-017).
- Poll: 2–12 non-empty options, posted as single-choice (multi-select out of scope) (FR-020). `sendPoll` returns a `PollKeyset` (FR-021).
- Poll vote: obtain the poll's `messageSecret`+options from the in-session message store if the poll-creation message is still cached, else from `resolvePollKeyset`; if neither yields it, skip (no error). Each `PollVote` is a full per-voter selection; the consumer aggregates (FR-021/FR-022/FR-023).
- Send/poll/delete before `connected`: reject with a clear error (Edge Cases).
- Delete: best-effort; rejection reported, never thrown to crash (FR-028).
- Identity: always reduce to `canonicalId` before counting/reporting (FR-025/FR-026).
