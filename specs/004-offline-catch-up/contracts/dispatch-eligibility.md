# Contract: Inbound Dispatch Eligibility & Own-Send Claim

**Feature**: `004-offline-catch-up` | **Date**: 2026-06-16

This feature changes **internal behaviour** of the WhatsApp Gateway, not its public API. The
public surface (`index.ts` exports, `IncomingMessage`/`PollVote` shapes, the `onMessage`/
`onPollVote`/`onConnectionChange` callbacks) is **unchanged**. The contract below specifies the
new internal dispatch rule and the own-send claim — the behaviour the FR-012 unit tests assert.

---

## C1 — The dispatch-eligibility decision (replaces the notify-only gate)

A pure function decides, per inbound item, whether it should be dispatched. It does **not** depend
on the upsert `type`.

**Inputs** (all derivable from a `WAMessage` + the batch `type`, without a socket):
- `authorized: boolean` — `groupFilter.isAuthorized(remoteJid)` (the single chokepoint, FR-005).
- `claim: () => boolean` — invokes `messageStore.claimOnce(messageStoreKey(remoteJid, id))`
  (the at-most-once guard, FR-003). Side-effecting test-and-set.
- (`type` MAY be passed for logging only; it MUST NOT affect the result — FR-011.)

**Decision** (in order; first failing condition stops dispatch):

| # | Condition | On fail |
|---|-----------|---------|
| 1 | `authorized` is true | drop — cross-chat item (FR-005/SC-004) |
| 2 | `claim()` returns true | suppress — already claimed: own-send echo (FR-004) or re-delivery (FR-003) |

If both pass → **dispatch** (route to poll-vote handling when `pollUpdateMessage` is present, else
map to `onMessage`). An item with no `id` cannot be claimed and dispatches as before (rare;
existing behaviour).

**Guarantees**:
- **G1 (catch-up admitted)**: an `append` item from the authorized group that has not been claimed
  is dispatched exactly as the equivalent `notify` item would be (FR-001/FR-002).
- **G2 (no cross-chat leakage)**: an item from any non-authorized chat is dropped regardless of
  `type` (FR-005/SC-004).
- **G3 (at-most-once)**: a re-delivered `(remoteJid, id)` is dispatched at most once within the
  guard window (FR-003/SC-002/SC-005).
- **G4 (type-independence)**: the result is identical for `type='notify'` and `type='append'` given
  the same `(authorized, claim)` — i.e. the live/not-live tag no longer affects dispatch (FR-011).

---

## C2 — The own-send claim

When the Gateway sends, it pre-populates the at-most-once guard so the echo is suppressed by C1.2.

**Trigger**: successful `sendMessage(groupId, …)` or `sendPoll(groupId, …)` returning
`sent.key.id`.

**Effect**: `messageStore.claimOnce(messageStoreKey(groupId, sent.key.id))` is called once, after
`messageStore.set(sent)`.

**Guarantees**:
- **G5 (echo suppressed)**: a later inbound item with `(remoteJid=groupId, id=sent.key.id)` —
  the Gateway's own send echoed back, live or on reconnect — fails C1.2 and is not dispatched
  (FR-004/SC-003/US3). Holds for both messages and poll-creation echoes.
- **G6 (manual sends unaffected)**: a message the operator sends manually from their linked account
  has an id the Gateway never claimed, so it passes C1.2 and is dispatched as genuine inbound
  activity (FR-006/US3-AS3). The claim is keyed to the Gateway's programmatic send id, never to
  `fromMe`.
- **G7 (chat-scoped key)**: the claim key uses `remoteJid` (the group), not the sender participant,
  so it matches the echo irrespective of PN/LID addressing of the sender (resolves Open Question 2).

---

## C3 — Unchanged downstream contracts (reused, not redefined)

These are existing spec-002 contracts that now also apply to recovered items; this feature does not
modify them and they are restated only to mark the dependency:

- **Poll-vote decryption & keyset fallback** — recovered votes decrypt via the creator×voter matrix
  and the in-session→durable keyset resolution; an unkeyable vote is skipped without error (FR-007).
- **Per-voter last-write-wins** — recovered votes replace the voter's prior selection; an empty
  selection is a withdrawal (FR-008).
- **Benign replay tolerance** — `MessageCounterError` noise during re-sync stays non-fatal while
  genuine persistent decrypt failures still surface (FR-009/FR-030).

---

## Test obligations (FR-012)

The contract is satisfied when these unit tests pass (written first, per constitution II):

| Test | Asserts | Covers |
|------|---------|--------|
| recovered authorized `append` message → dispatch | C1 G1 | FR-001/FR-002 |
| recovered own-send echo (pre-claimed) → suppressed | C1.2 + C2 G5 | FR-004/SC-003 |
| recovered unauthorized-chat item → dropped | C1.1 G2 | FR-005/SC-004 |
| recovered new vote (authorized, unclaimed, pollUpdate) → routes to poll path | C1 G1 | FR-001 (US1) |
| recovered changed vote → last-write-wins replaces prior | C3 (poll-tally) | FR-008 (US1) |
| own-send claim then re-claim same key → false (and manual-send id → true) | C2 G5/G6 | FR-004/FR-006 |
| same `(remoteJid,id)` claimed twice → second dispatch suppressed | C1 G3 | FR-003/SC-005 |

The live-socket `append` delivery itself is validated manually (see `quickstart.md`), per the
ratified spec-002 exclusion for interactive WhatsApp paths.
