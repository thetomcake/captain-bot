# Contract: MVP ↔ WhatsApp Gateway seam (`IWhatsAppGateway`)

**Feature**: `003-mvp-attempt-2` | **Date**: 2026-06-15

This is the single integration seam between the MVP and the WhatsApp Gateway library
(`src/whatsapp-gateway/index.ts`, spec 002). It satisfies FR-006/SC-011: services depend on this
port, never on `WhatsAppGateway` directly and never on Baileys. The **real** `WhatsAppGateway`
satisfies the port structurally; the **test** `FakeGateway` implements it.

All types below (`ConnectionStatus`, `IncomingMessage`, `MessageRef`, `DeleteOutcome`, `PollSpec`,
`PollKeyset`, `PollRef`, `PollSendResult`, `PollVote`, `GroupSummary`, `Identity`,
`WhatsAppCredentials`) are imported from the Gateway's public surface and re-exported by the MVP's
`src/whatsapp/gateway-port.ts`. No new WhatsApp types are invented.

## Port interface (MVP-owned)

```ts
// src/whatsapp/gateway-port.ts
import type {
  ConnectionStatus, GroupSummary, IncomingMessage, MessageRef,
  DeleteOutcome, PollSpec, PollSendResult, PollVote,
} from '#src/whatsapp-gateway/index.js';

export interface IWhatsAppGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  status(): ConnectionStatus;

  listGroups(): Promise<GroupSummary[]>;
  sendMessage(groupId: string, text: string): Promise<MessageRef>;
  sendPoll(groupId: string, poll: PollSpec): Promise<PollSendResult>; // { ref, keyset }
  deleteMessage(ref: MessageRef): Promise<DeleteOutcome>;             // never throws

  onQR(handler: (qr: string) => void): void;
  onConnectionChange(handler: (s: ConnectionStatus) => void): void;
  onMessage(handler: (m: IncomingMessage) => void | Promise<void>): void;
  onPollVote(handler: (v: PollVote) => void | Promise<void>): void;
}
```

The real `WhatsAppGateway` exposes a superset (it also has `forceReauth`/`getCredentials`); the
factory exposes those it needs. The port lists exactly what MVP services/commands consume.

## Factory contract (`src/whatsapp/gateway-factory.ts`)

Builds a configured real Gateway wired to DB-backed callbacks. **Behavioural requirements**:

1. **authorizedGroups** = `[AUTHORIZED_GROUP_ID]` from env. For `connect`/group-discovery use,
   `[]` is allowed (Gateway permits auth-only with no group).
2. **credentials**: load the stored opaque snapshot for the team (or `undefined` ⇒ fresh QR).
3. **onCredentialsUpdate(snapshot)**: persist verbatim to `gateway_credentials` (FR-008).
4. **resolvePollKeyset(ref)**: look up `polls` by `pollMessageId == ref.pollId AND groupId ==
   ref.groupId`; return `{ pollId: pollMessageId, groupId, messageSecret, options: pollOptions }`
   or `null` (FR-014 — `null` ⇒ Gateway skips the vote, no error). Note `ref.pollId` is the
   poll-creation message id — the same value the MVP stored as `pollMessageId` and uses for
   `deleteMessage`; there is no separate poll id (see data-model.md "Poll identifiers").
5. **logger**: the MVP's timestamped logger (FR-025) adapted to the Gateway `Logger` shape.
6. Leaves `minMessageDelayMs`/`reconnect` at Gateway defaults (the MVP must not implement its own
   rate-limiting or reconnection — FR-010).

## Credential store (`src/whatsapp/credentials-store.ts`)

| Operation | Behaviour |
|-----------|-----------|
| `load(teamId)` | return stored `snapshot` string or `undefined` |
| `save(teamId, snapshot)` | upsert `gateway_credentials` row, set `updatedAt` |

## Keyset store (`src/whatsapp/keyset-store.ts`)

| Operation | Behaviour |
|-----------|-----------|
| `persist(poll keyset)` | write `messageSecret`+`groupId` onto the poll row at `sendPoll` time |
| `resolve(ref)` | reconstruct `PollKeyset` from the poll row, or `null` if absent/replaced |

## Usage by stories

- **US2 post poll**: `sendPoll(group, { question, options })` → persist `keyset` (write
  `messageSecret`+`groupId` onto the poll row; `keyset.pollId` is stored as `pollMessageId`).
- **US2 votes**: `onPollVote(v)` → resolve user by `v.voter.canonicalId`; **persist the delta
  immediately** as a replace-by-voter update of `poll_responses` (`selectedOptions: []` ⇒ delete
  the row, else upsert). The DB rows are the durable tally — the MVP does **not** rely on the
  Gateway's stateless `aggregateVotes` as the source of truth (it would not survive a restart).
- **US3 stats**: `onMessage(m)` → if `m.text` and within the 3-day window, run `StatExtractor`,
  attribute to `m.sender.canonicalId`. Branch on `m.fromMe` if the operator's own messages should
  be treated differently (they ARE delivered).
- **connect**: `connect()` then `listGroups()` → print `id [addressingMode] name`; `onQR` renders.
- **daemon**: `onConnectionChange` → log state only (no reconnection action, FR-010).
- **poll replacement (FR-027)**: `deleteMessage(ref)` → inspect `DeleteOutcome`; on `{ ok: false }`
  log a timestamped warning and continue.

## Fake Gateway (tests — `tests/helpers/fake-gateway.ts`)

Implements `IWhatsAppGateway` in memory; replaces the deleted `MockWhatsAppClient`. Must provide:

- recorded `sentPolls` (with returned `keyset`), `sentMessages`, `deletedMessages`;
- `failNextSendPoll` / `deleteOutcomeOverride` toggles for failure-path tests;
- `simulateMessage(Partial<IncomingMessage>)` and `simulatePollVote(PollVote)` to drive handlers;
- canonical `Identity` fixtures so identity-keyed assertions (SC-008) are exercised;
- **no** Baileys import (boundary fake only).
