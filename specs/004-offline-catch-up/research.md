# Phase 0 Research: Offline Catch-Up on Reconnect

**Feature**: `004-offline-catch-up` | **Date**: 2026-06-16

All "NEEDS CLARIFICATION" and the spec's two Open Questions are resolved below against the
**installed** library and the **actual** Gateway code (not docs or memory).

---

## Decision 1 — How offline catch-up is delivered, and what "not-live" actually tags

**Decision**: Offline catch-up arrives on the standard `messages.upsert` event with
`type === 'append'`. The Gateway's relaxation targets exactly this event; no new event handler is
added.

**Evidence** (installed `@whiskeysockets/baileys` 7.0.0-rc13):
- `lib/Socket/messages-recv.js:1432` — the main inbound path upserts each decrypted message as
  `await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')`. A message the server
  flushes because it was queued while the device was offline carries `node.attrs.offline`, so it
  is emitted as **`'append'`**; a live message is **`'notify'`**.
- Crucially, the per-message `offline` boolean is **consumed inside Baileys** to choose the
  upsert `type`; it is **not** propagated onto the `WAMessage` delivered to the consumer. At the
  Gateway's `handleMessagesUpsert` (`gateway.ts:435`), only `upsert.type` is observable — there is
  no per-item flag distinguishing an offline-flush `append` from any other `append`.

This confirms spec **Assumption 1** ("catch-up arrives on the standard inbound channel, merely
tagged not-live") with primary-source evidence.

**Rationale**: Since the offline marker is not exposed, the dispatch decision cannot be "accept
`append` only when offline-flagged". It must instead stop depending on `type` altogether and rely
on other guards (Decisions 2–4). This is precisely what FR-011 prescribes.

**Alternatives considered**:
- *Detect the offline marker per item* — rejected: not exposed by Baileys at the consumer
  boundary (would require patching the library / reading private socket internals).
- *Consume the history-sync channel instead* — rejected: out of scope (FR-013) and heavier; see
  Decision 5.

---

## Decision 2 — The new dispatch criterion (FR-001 / FR-011)

**Decision**: Remove the live/not-live gate. An inbound item is dispatchable iff it (a) is from an
**authorized group** and (b) **wins its `claimOnce`** for `(remoteJid, message-id)`. The `type`
field no longer participates in the dispatch decision (it stays only as a debug log field).

**What else arrives as `append`, and why relaxing is safe** (audited in `messages-recv.js`):
- `:1432` — offline-flush group/DM messages → **this is the catch-up we want** (FR-001/FR-002).
- `:346` — plaintext **newsletter** messages → rejected by the authorized-group filter
  (`group-filter.ts`: `isJidGroup` + allow-list), never reach a consumer (FR-005).
- `:1257` — retry/peer message reconstruction (a re-delivery of a message already seen) → caught
  by the at-most-once guard (Decision 3); not double-dispatched (FR-003).
- Own programmatic-send echoes also return as `append` (`message-mapper.ts:8` comment) → caught
  by the own-send claim (Decision 4).

So every `append` source other than genuine catch-up is already neutralised by the
authorization + dedup + own-send guards. The notify-only gate is redundant once those hold, and
removing it admits exactly the catch-up traffic and nothing else.

**Implementation shape**: extract the per-item decision currently inlined in
`handleMessagesUpsert` (`gateway.ts:466-500`) into a pure function in `message-mapper.ts` (where
`isNewInbound` lives today). The function takes the authorized flag and a claim callback and
returns whether to dispatch — making the five FR-012 scenarios unit-testable without a socket.
`isNewInbound` is retired (or reduced to a no-op/removed and its test rewritten), satisfying
FR-011's "the previous rule MUST be removed or reduced to the group filter".

**Rationale**: One chokepoint, two guards, no reliance on an unobservable tag. Matches the
existing code's "single authorization chokepoint" design comment (`gateway.ts:460-465`).

---

## Decision 3 — At-most-once across catch-up (FR-003 / SC-002 / SC-005)

**Decision**: Reuse the existing `MessageStore.claimOnce` guard unchanged. It already runs for
every authorized item before dispatch (`gateway.ts:490-500`) and covers **both** the text and
poll-vote paths (the claim happens before routing to `handlePollUpdate`).

**Evidence**: `message-store.ts:44-57` — bounded `Set<string>` keyed by
`messageStoreKey(remoteJid, id)` (`:18-24`), test-and-set semantics, LRU eviction past
`DEFAULT_MAX_SIZE = 1000` (`:16`). Already unit-tested (`message-store.test.ts`).

**Window sufficiency**: a multi-hour outage in a single low-volume group yields well under 1000
distinct messages, so a reconnect burst fits inside the window (spec Assumption "window
sufficient"). The spec already accepts that an item separated far enough to fall outside the
window MAY re-dispatch (Edge Case "Re-delivery window") — best-effort, non-fatal — so no window
tuning is required for this feature.

**Rationale**: The guard is the explicit precondition the spec names (FR-034 dependency); reusing
it is what makes relaxing the filter safe.

---

## Decision 4 — Own-send echo suppression (FR-004 / US3) — resolves Open Question 2

**Decision**: Claim `(groupId, sent.key.id)` via `messageStore.claimOnce(...)` at **send time**,
immediately after the existing `messageStore.set(sent)` call, in both `sendMessage`
(`gateway.ts:248`) and `sendPoll` (`gateway.ts:333`). When WhatsApp later echoes that send back
(live or on reconnect), its `claimOnce` returns `false` and it is suppressed before dispatch.

**Why the claim key matches the echo** (resolves the OQ2 "alternate address form" worry):
- The dedup/claim key is `(remoteJid, message-id)` where `remoteJid` is the **chat/group**, not
  the sender. An echo of our own send returns in the same group with the same client-generated
  message id, so the key is identical regardless of how the *sender* participant is addressed
  (PN vs LID). The addressing-mode ambiguity that affects identity resolution does **not** affect
  the chat-scoped claim key. Hence the claim neutralises the echo form the protocol returns.
- Genuine member messages — including a message the operator sends **manually** from their linked
  account (FR-006) — have message ids the Gateway never claimed, so they win their `claimOnce` and
  are dispatched. The claim is keyed to the Gateway's *programmatic* `sent.key.id`, not to
  "fromMe", so manual operator messages are unaffected.

**OQ2 verdict**: Confirmed. The send-time claim + the chat-scoped dedup key fully replace the
notify-only filter's echo-suppression role. No regression in echo suppression is introduced by
relaxing the live-only gate. This validates the spec's premise for FR-004/FR-011.

**Rationale**: `sent.key.id` and `groupId` are already in hand at both send sites and the message
is already cached there; the claim is a one-line addition reusing the exact key the inbound path
checks.

**Alternatives considered**:
- *Track a separate "own-send" set* — rejected: redundant; the existing `claimOnce` set is exactly
  an "already-accounted-for `(chat,id)`" record, which is the own-send claim's meaning.
- *Filter echoes by `fromMe`* — rejected: would also drop the operator's legitimate manual
  messages (FR-006) and the operator's own votes; `fromMe` is not echo-vs-genuine.

---

## Decision 5 — Catch-up age bound & history scope (FR-013) — resolves Open Question 1

**Decision**: Impose **no** Gateway-side age bound. The Gateway processes whatever the server
flushes on reconnect and nothing older. Full older-history sync stays disabled.

**Evidence**: `gateway.ts:396-397` — `markOnlineOnConnect: false`, `syncFullHistory: false`; and
the socket registers only `connection.update`, `creds.update`, and `messages.upsert`
(`gateway.ts:404-407`) — **no `messaging-history.set` handler**. Therefore the separate
history-sync channel is neither enabled nor consumed; relaxing the `messages.upsert` gate cannot
pull in chat history predating the outage window. The server's offline buffer is the only source,
and it only retains what was queued for this device while offline (spec Assumption "server defines
how far back").

**OQ1 verdict**: Default assumption holds — "process whatever the server flushes, no extra
bound." There is no business need to ignore very old recovered items: a recovered vote for a poll
the operator considers closed simply updates that poll's tally via the same last-write-wins path,
which is correct behaviour, and a vote whose keyset is unrecoverable is skipped without error
(Decision 6). If a future need to ignore aged items arises, it belongs to the consumer (the MVP),
not the Gateway.

**Rationale**: Keeps the feature to the "offline catch-up flush only" scope (FR-013) and avoids
the history-sync machinery deferred to Future Enhancements.

---

## Decision 6 — Recovered poll-vote decryption, keyset fallback, withdrawal (FR-007 / FR-008)

**Decision**: No change. Recovered votes route to the **existing** `handlePollUpdate`
(`gateway.ts:546-649`) once they pass the relaxed gate. Decryption uses the existing
creator×voter try-both matrix (`poll-vote-decryptor.ts:115-135`), the keyset resolves via the
in-session cache → durable `config.resolvePollKeyset` fallback (`resolvePollSecret`,
`gateway.ts:657-696`), and per-voter last-write-wins / withdrawal-as-empty-selection is the
existing consumer-side aggregation (`poll-tally.ts:24-65`).

**Unkeyable recovered vote**: `resolvePollSecret` returns `undefined` → the vote is skipped with a
debug log and no error (`gateway.ts:563-570`) — identical to a live unkeyable vote, satisfying the
spec Edge Case and FR-007.

**Rationale**: The relaxation only changes *whether the item reaches* `handlePollUpdate`; once it
does, every downstream poll-vote behaviour is the proven live-path behaviour, so US1 (recovered
new/changed votes, withdrawal) is satisfied by reuse, not new logic.

---

## Decision 7 — Benign replay tolerance during re-sync (FR-009 / FR-030)

**Decision**: No change. The existing Baileys-logger adapter downgrades any error whose payload
contains `MessageCounterError` to debug level (`gateway.ts:898-923`), so the cryptographic-counter
warnings a catch-up burst triggers stay non-fatal, while genuinely persistent decrypt failures on
live traffic still surface as errors.

**Rationale**: Catch-up bursts are exactly the re-sync scenario this tolerance was built for; it
already covers the new flow with no modification (FR-009 explicitly reuses FR-030).

---

## Decision 8 — Testing strategy (FR-012, constitution II)

**Decision**: Unit-test the **extracted pure dispatch-decision function** for the five FR-012
scenarios, and assert the **own-send-claim semantics** against the real in-memory `MessageStore`:

1. Recovered authorized message (`type='append'`, authorized, unclaimed) → **dispatch**.
2. Recovered own-send echo (claimed at send time) → **suppressed** (`claimOnce` → false).
3. Recovered unauthorized-chat item → **rejected** by the group filter.
4. Recovered new vote → routes to the poll path (decision returns "dispatch", `isPollVote`).
5. Recovered changed vote → same path; last-write-wins is covered by the existing
   `poll-tally.test.ts` (vote replacement / withdrawal) and is not re-implemented.

The live-socket reconnect/append delivery itself is validated **manually** via the Gateway's
`bin/listen.ts` + `bin/watch-votes.ts` and `quickstart.md` — the same ratified exclusion spec 002
applies to interactive WhatsApp paths (can't run real WhatsApp in CI). This keeps mocking at the
project's own boundaries (pure functions + `MessageStore`), never Baileys internals
(`tests/README.md`).

**Rationale**: Extraction matches the codebase's existing pure-unit seams (`message-mapper`,
`message-store`), so test-first is achievable with fast, deterministic, library-free unit tests —
satisfying FR-012 and constitution II without standing up a socket.
