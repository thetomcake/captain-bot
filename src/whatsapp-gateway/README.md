# WhatsApp Gateway

A self-contained library that hides all [Baileys](https://github.com/WhiskeySockets/Baileys)
complexity behind one small, stable, well-typed interface. It owns authentication
(+ forced re-auth), connection/reconnection, group listing, send/receive, native
polls, **poll-vote decryption and tally**, and best-effort deletion — restricted to
one (or a few) authorized group(s), with JID/LID identity canonicalization built in.

You integrate against `index.ts` alone. **No Baileys type ever appears in the public
surface**, so you never need to read Baileys docs to use this — everything below is
the complete contract.

- **Storage-agnostic.** The library persists **nothing** and touches no disk or
  database. You hold the opaque credential snapshot and poll keysets and pass them
  back in; the library hands them to you via callbacks. (Its only in-process state
  is a bounded, ephemeral in-memory message cache that backs send-retries and an
  in-session poll-secret fast-path — never persisted, gone on restart.)
- **Pinned engine.** Built and verified against `@whiskeysockets/baileys@7.0.0-rc13`
  (pinned exactly — RC behaviour shifts between releases). In this version built-in
  poll-vote auto-decryption is disabled, so the Gateway decrypts votes itself.
- **Single project, ESM/NodeNext**, strict TypeScript, Node.js 22.x.

---

## Quick start

```ts
import { WhatsAppGateway } from './index.js';

const gw = new WhatsAppGateway({
  authorizedGroups: ['<group-id>@g.us'], // only act in / report from these groups

  // You persist credentials however you like (file, DB, secret store).
  credentials: loadSnapshotOrUndefined(), // opaque string from a previous session
  onCredentialsUpdate: (snapshot) => saveSnapshot(snapshot), // fired on every change
});

gw.onQR((qr) => renderQrSomehow(qr)); // only fires when there is no/expired session
gw.onConnectionChange((status) => console.log('status:', status));
gw.onMessage((msg) => console.log(`${msg.sender.canonicalId}: ${msg.text}`));

await gw.connect(); // resolves once truly 'connected'; rejects on terminal close

const ref = await gw.sendMessage('<group-id>@g.us', 'Hello, group!');
console.log('sent', ref.id);

await gw.disconnect();
```

First run with no `credentials` ⇒ `onQR` fires; scan it to pair. Persist the snapshot
you receive in `onCredentialsUpdate`, pass it back as `credentials` next time, and
subsequent `connect()`s resume silently with **no** QR.

---

## Public surface

The entire surface exported from `index.ts`:

- `class WhatsAppGateway` — the gateway (below).
- `function aggregateVotes(votes: PollVote[]): PollResult` — pure, stateless helper
  that folds per-voter `PollVote` deltas into a per-option tally (the library keeps
  no tally of its own).
- The domain types: `ConnectionStatus`, `WhatsAppCredentials`, `GroupSummary`,
  `Identity`, `IncomingMessage`, `MessageRef`, `DeleteOutcome`, `PollSpec`,
  `PollKeyset`, `PollRef`, `PollSendResult`, `PollVote`, `PollOptionResult`,
  `PollResult`, `ReconnectPolicyConfig`, `Logger`, `GatewayConfig`.

### Construction — `GatewayConfig`

```ts
interface GatewayConfig {
  authorizedGroups?: string[];   // group JIDs (…@g.us) this gateway may act in.
                                 // Default []. Auth-only / discovery (connect,
                                 // forceReauth, listGroups) need none; receive/send/
                                 // poll operations require ≥1. Every entry must be a
                                 // group JID or the constructor throws.

  credentials?: WhatsAppCredentials;                       // opaque snapshot to resume; omit ⇒ fresh QR
  onCredentialsUpdate?: (c: WhatsAppCredentials) => void | Promise<void>; // persist on every change

  resolvePollKeyset?: (ref: PollRef) => PollKeyset | null | Promise<PollKeyset | null>;
                                 // fallback secret lookup for a vote whose poll-creation
                                 // message is no longer cached this session; null ⇒ skip
                                 // that vote (no error)

  minMessageDelayMs?: number;    // default 12000 (≤5 msg/min — conservative, ban-risk)
  maxRestartHandshakes?: number; // default 5  (bounds the post-pairing 515 handshake loop)
  reconnect?: Partial<ReconnectPolicyConfig>; // backoff for recoverable closes
  logger?: Logger;               // default: no-op
}
```

Defaults: `minMessageDelayMs=12000`, `maxRestartHandshakes=5`, reconnect
`{ baseDelayMs: 1000, maxDelayMs: 30000, factor: 2, jitter: true, maxAttempts: null }`.

### Methods

| Method | Behaviour |
|--------|-----------|
| `connect(): Promise<void>` | Resolves once truly `connected`; emits `onQR` when there is no/expired session; transparently absorbs the 515 post-pairing handshake (bounded by `maxRestartHandshakes`); auto-reconnects recoverable closes on a bounded, jittered backoff; **rejects** and goes `terminal` on a non-recoverable close. |
| `disconnect(): Promise<void>` | Graceful close, **no logout**. Stays disconnected (no auto-reconnect). |
| `forceReauth(): Promise<void>` | Best-effort logout + clears in-memory credentials. Discard your stored snapshot afterwards so the next `connect()` QR-pairs fresh. |
| `isConnected(): boolean` | `true` only when `status() === 'connected'`. |
| `status(): ConnectionStatus` | `'connecting' \| 'connected' \| 'closed' \| 'terminal'`. |
| `getCredentials(): WhatsAppCredentials \| null` | Current opaque snapshot on demand (e.g. persist on shutdown). Returns the **live** state, never a stale constructor-time snapshot. |
| `listGroups(): Promise<GroupSummary[]>` | All participating groups (`id`, `name`, `addressingMode`); empty array if none. Requires a live connection. |
| `sendMessage(groupId, text): Promise<MessageRef>` | Rate-limited; throws if not connected; returns a `MessageRef`. |
| `sendPoll(groupId, poll): Promise<PollSendResult>` | Validates 2–12 non-empty options (single-choice); throws if not connected; posts the poll with a Gateway-generated secret and returns `{ ref, keyset }`. **You MUST persist `keyset`** to decrypt later votes after this session. |
| `deleteMessage(ref): Promise<DeleteOutcome>` | Best-effort revoke of a message/poll the Gateway sent. **Never throws** on a WhatsApp rejection — returns `{ ok: false, reason }`. Rate-limited (a revoke is an outbound send). |

### Subscriptions

Register before `connect()`. Handlers may be sync or async; a throwing handler can't
break the gateway's internal loop.

| Method | Fires |
|--------|-------|
| `onQR(handler: (qr: string) => void)` | When pairing is needed — render the string as a QR code (e.g. `qrcode-terminal`). |
| `onConnectionChange(handler: (status: ConnectionStatus) => void)` | On every lifecycle transition. |
| `onMessage(handler: (msg: IncomingMessage) => void \| Promise<void>)` | For every authorized-group message — live **and** offline catch-up re-delivered on reconnect (`append`), each at most once — **including the operator's own manual messages** (the linked account is a participant, so `fromMe` may be `true`). Never for the Gateway's own programmatic-send echoes (suppressed by the send-time own-send claim) or other chats. Branch on `msg.fromMe` if you must treat your own messages differently. |
| `onPollVote(handler: (vote: PollVote) => void \| Promise<void>)` | Once per successfully decrypted vote, with the voter's canonical `Identity` and full current selection. A changed vote is the voter's new full selection; a withdrawal is `selectedOptions: []`. Correct in LID groups; no LID/PN double-identity. |

---

## Polls — the durable-secret pattern

Poll votes are end-to-end encrypted with a per-poll secret. The library decrypts them
for you but keeps no durable copy of the secret, so **you** must persist it:

1. `sendPoll()` returns `{ ref, keyset }`. Persist `keyset` (it holds the base64
   `messageSecret`, the `options`, and `pollId`/`groupId`).
2. When a vote arrives, the library first looks for the poll's secret in its in-session
   message cache (free if the poll was created this session). If it's not cached
   (e.g. after a restart), it calls your `resolvePollKeyset(ref)` — return the stored
   keyset, or `null` to skip that vote without error.
3. Decrypted votes arrive on `onPollVote` as per-voter deltas. Fold them into a tally
   with `aggregateVotes` whenever you want a current snapshot:

```ts
const votes: PollVote[] = [];
gw.onPollVote((v) => {
  votes.push(v); // append every delta
  const result = aggregateVotes(votes); // last-write-per-voter, LID/PN-canonical
  for (const opt of result.options) {
    console.log(`${opt.name}: ${opt.voteCount}`);
  }
});
```

`aggregateVotes` is pure and stateless: last-write-per-voter (a later selection
replaces an earlier one), `[]` withdraws the voter, and a voter seen as both LID and
PN collapses to one canonical identity (no double-count).

---

## Identity (LID / PN canonicalization)

Every person in `IncomingMessage.sender` and `PollVote.voter` is a canonical
`Identity` (`canonicalId` + optional `pn`/`lid`/`displayHint`). The resolver reconciles
the LID and phone-number (PN) forms of one person into a single `canonicalId` (device
suffixes stripped, PN preferred). Reconciliation relies on the counterpart form
arriving alongside (Baileys' `*Alt` fields); when it doesn't, the same person seen as
LID once and PN another time could be counted twice — see the resolver's notes.

## DeleteOutcome

```ts
type DeleteOutcome =
  | { ok: true }
  | { ok: false; reason: 'window-expired' | 'not-found' | 'network' | 'unknown'; detail?: string };
```

`{ ok: true }` means the revoke stanza was **sent**, not that WhatsApp confirmed
removal — Baileys' revoke is fire-and-forget (it awaits no server ack). Consequently
only `network` and `unknown` are produced in practice; `window-expired` and
`not-found` are **reserved** in the union (a server-side rejection never surfaces as a
thrown error) for contract stability.

---

## Manual entry points (`bin/`)

One single-purpose script per action — no shared CLI framework or arg parser. Each
imports only `../index.js`, reads inputs from environment variables, and acts as the
*consumer* that persists credentials/keysets to local files (the **library** still
writes nothing). Run with `tsx`:

| Script | Inputs (env) | Does |
|--------|--------------|------|
| `connect.ts` | `WA_CREDS_FILE` | Connect; render QR on first run; resume silently after. |
| `force-reauth.ts` | `WA_CREDS_FILE` | Connect, `forceReauth()`, delete the creds file → next run re-pairs. |
| `list-groups.ts` | `WA_CREDS_FILE` | Print an `id  [addressingMode]  name` table. |
| `send-message.ts` | `WA_CREDS_FILE`, `WA_GROUP_ID`, `WA_TEXT` | Send text, print the `MessageRef`. |
| `listen.ts` | `WA_CREDS_FILE`, `WA_GROUP_ID` | Long-running; print each authorized-group inbound message. |
| `send-poll.ts` | `WA_CREDS_FILE`, `WA_GROUP_ID`, `WA_POLL_QUESTION`, `WA_POLL_OPTIONS` (comma-sep, 2–12), `WA_POLL_KEYS_FILE` | Post a poll; append the returned `PollKeyset` to the keys file. |
| `watch-votes.ts` | `WA_CREDS_FILE`, `WA_GROUP_ID`, `WA_POLL_KEYS_FILE` | Long-running; wire `resolvePollKeyset` from the keys file; print per-voter selections + a running `aggregateVotes` tally. |
| `delete-message.ts` | `WA_CREDS_FILE`, `WA_GROUP_ID`, `WA_MESSAGE_ID` | Best-effort revoke; print the `DeleteOutcome`. |

```bash
# Pair a session:
WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/connect.ts

# Send a message:
WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=…@g.us WA_TEXT='hi' \
  npx tsx src/whatsapp-gateway/bin/send-message.ts

# Post a poll, then watch votes (separate terminal):
WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=…@g.us \
  WA_POLL_QUESTION='Lunch?' WA_POLL_OPTIONS='Pizza,Sushi,Tacos' \
  WA_POLL_KEYS_FILE=./.wa-poll-keys.json \
  npx tsx src/whatsapp-gateway/bin/send-poll.ts

WA_CREDS_FILE=./.wa-creds.json WA_GROUP_ID=…@g.us \
  WA_POLL_KEYS_FILE=./.wa-poll-keys.json \
  npx tsx src/whatsapp-gateway/bin/watch-votes.ts
```

The `.wa-creds.json` / `.wa-poll-keys.json` files are git-ignored (consumer-side; the
library owns no storage).
</content>
</invoke>
