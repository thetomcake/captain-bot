# Phase 1 Data Model: Auto-Pin the Availability Poll

**Feature**: 007-auto-pin-poll | **Date**: 2026-06-18

This feature introduces **no database schema change and no new persisted state**. The pin/unpin are
transient WhatsApp side-effects. The only "data" is a small set of in-memory types crossing the
Gateway seam and one derived value.

## Persistence

**No change.** The existing `polls` row (with its stored `PollKeyset`) and the `games`/`seasons`
schema are untouched. Whether a poll is pinned is not recorded — the pin lives only on WhatsApp.

## New / changed types

### `PinOutcome` (new — Gateway public surface, `src/whatsapp-gateway/types.ts`)

Result of a best-effort pin or unpin. Never thrown — always returned (mirrors `DeleteOutcome`).

```ts
export type PinOutcome =
  | { ok: true }
  | { ok: false; reason: 'network' | 'unknown'; detail?: string };
```

- `ok: true` — the pin/unpin stanza was **sent** (fire-and-forget; WhatsApp does not ack it), not a
  proof of server-side state change.
- `reason: 'network'` — transport drop mid-send. `reason: 'unknown'` — encryption/precondition fault.
- Re-exported from `src/whatsapp-gateway/index.ts` and `src/whatsapp/gateway-port.ts`.

### `IWhatsAppGateway` (changed — `src/whatsapp/gateway-port.ts`)

Two methods added to the port the MVP consumes (the concrete `WhatsAppGateway` satisfies them
structurally; `FakeGateway` implements them in memory):

```ts
/** Pin an already-sent message for ~`durationSeconds` (gateway maps to the nearest WhatsApp bucket). */
pinMessage(ref: MessageRef, durationSeconds: number): Promise<PinOutcome>; // never throws
/** Unpin an already-sent message. */
unpinMessage(ref: MessageRef): Promise<PinOutcome>;                        // never throws
```

`MessageRef` (`{ id, groupId }`) is the existing type already returned by `sendPoll`/`sendMessage`.

### Pin duration bucket (derived — pure helper, not stored)

```ts
export type PinDurationSeconds = 86400 | 604800 | 2592000; // 24h | 7d | 30d (Baileys-allowed set)
export function selectPinDuration(requestedSeconds: number): PinDurationSeconds;
```

- Returns the **smallest** bucket `≥ requestedSeconds`; `2592000` when the request exceeds 30 days.
- Defensive `≤ 0` → `86400` (cannot occur in practice — see Validation rules).

## Validation rules (from requirements)

- **Game time is always in the future** at post time (spec assumption; next-fixture selection only
  yields unplayed, future-dated fixtures) ⇒ `secondsUntilGame > 0` ⇒ a real pin is always requested.
- **Pin only via the seam** (FR-007): MVP calls `IWhatsAppGateway.pinMessage`/`unpinMessage`, never
  Baileys.
- **Best-effort** (FR-006): a `{ ok: false }` outcome (or any unexpected throw, defensively caught)
  MUST NOT abort poll posting, replacement, recording, or vote tracking — it is logged only.
- **Pin the new poll, unpin the old** (FR-004/FR-005): on replacement, `unpinMessage(old)` precedes
  `deleteMessage(old)`; `pinMessage(new)` applies to the freshly sent poll.

## State / ordering (poll-posting flow, `PollService.postOrReplaceNextPoll`)

```text
1. resolve next fixture (existing)
2. sendPoll(group, spec) → { ref, keyset }            (existing; abort on failure before any DB write)
3. if replacing an existing poll:                     (removeExistingPoll)
     a. delete poll_responses + polls rows             (existing)
     b. unpinMessage(oldRef)   ── best-effort, logged ── BEFORE delete   (FR-005, NEW)
     c. deleteMessage(oldRef)  ── best-effort           (existing)
4. persist new keyset + recordPollPosted               (existing)
5. pinMessage(newRef, secondsUntilGame)  ── best-effort, logged ──       (FR-002/FR-004, NEW)
6. return outcome
```

`secondsUntilGame = floor((game.gameDate − now()) / 1000)`, with `now` the injected clock (FR-008).
