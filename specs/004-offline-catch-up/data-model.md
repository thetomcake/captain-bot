# Phase 1 Data Model: Offline Catch-Up on Reconnect

**Feature**: `004-offline-catch-up` | **Date**: 2026-06-16

This feature introduces **no persistent storage and no schema change** (FR-010). The Gateway is
stateless across restarts; the consumer's durable poll-keyset and credential state are untouched.
The entities below are **conceptual / in-memory** and describe the data the dispatch decision
operates on. Field names map to existing public types in `src/whatsapp-gateway/types.ts` and the
internal `MessageStore`.

---

## Entity: Inbound catch-up item

A message or poll-vote update WhatsApp re-delivers on reconnect because it arrived while the
Gateway was offline. At the Gateway boundary it is an ordinary Baileys `WAMessage` inside a
`messages.upsert` batch.

| Field (observable) | Source | Notes |
|--------------------|--------|-------|
| `upsert.type` | `messages.upsert` | `'append'` for catch-up, `'notify'` for live. **No longer gates dispatch** (FR-011); kept only as a debug log field. The per-message `offline` marker that produced `'append'` is **not** exposed (research Decision 1). |
| `key.remoteJid` | `WAMessage.key` | The chat/group JID. Drives the authorization check and the claim key. |
| `key.id` | `WAMessage.key` | Message id; second half of the claim key `(remoteJid, id)`. |
| `key.fromMe` | `WAMessage.key` | True for the Gateway's own sends **and** the operator's manual sends — NOT used to suppress (FR-006); echoes are suppressed by the own-send claim, not by `fromMe`. |
| `message.pollUpdateMessage` | `WAMessage.message` | Present → routes to the poll-vote path; absent → text/message path. |

**State transition** (per item, post-relaxation):

```
received (append|notify)
  └─ authorized group?  ── no ──▶ dropped (cross-chat, FR-005)
        │ yes
        ▼
     claimOnce(remoteJid,id)?  ── false (already claimed: echo or re-delivery) ──▶ suppressed (FR-003/FR-004)
        │ true
        ▼
     pollUpdateMessage?  ── yes ──▶ handlePollUpdate ──▶ onPollVote   (US1)
        │ no
        ▼
     mapIncomingMessage ──▶ onMessage                                  (US2)
```

This reclassifies a catch-up item as **genuine inbound activity** subject to the same guards as
live traffic (spec Key Entities).

---

## Entity: Own-send claim

A record that the Gateway itself originated a given `(chat, message-id)`, established at send time,
used to suppress that message's later echo (FR-004).

| Aspect | Value |
|--------|-------|
| Representation | An entry in the existing `MessageStore.claimed` set — the **same** structure the at-most-once guard uses. There is no separate store. |
| Key | `messageStoreKey(groupId, sent.key.id)` — chat-scoped, sender-agnostic (research Decision 4). |
| Established | In `sendMessage` (`gateway.ts:248`) and `sendPoll` (`gateway.ts:333`), immediately after `messageStore.set(sent)`, via `messageStore.claimOnce(key)`. |
| Consumed | On the inbound path: the echo's `claimOnce` returns `false`, so it is suppressed before dispatch. |
| Lifetime | Bounded LRU window (`DEFAULT_MAX_SIZE = 1000`); shares the at-most-once guard's eviction. |

Conceptually identical to the at-most-once guard's identity — the claim simply pre-populates the
guard for messages the Gateway will see echoed.

---

## Entity: Recovered poll vote

A poll-vote update recovered from catch-up, carrying the voter's full current selection.

| Field | Public type | Notes |
|-------|-------------|-------|
| `pollId` | `PollVote.pollId` | Poll-creation message id; keys the durable keyset lookup. |
| `groupId` | `PollVote.groupId` | The authorized group. |
| `voter` | `PollVote.voter` (`Identity`) | Canonicalised (PN/LID) by the existing `IdentityResolver`. |
| `selectedOptions` | `PollVote.selectedOptions` (`string[]`) | Full current selection; **empty array = withdrawal** (FR-008). |
| `timestamp` | `PollVote.timestamp` | From the recovered message. |

**Decryption & application** (unchanged, research Decision 6): keyset resolves via in-session cache
→ durable `config.resolvePollKeyset`; decrypt via the creator×voter matrix; an unkeyable recovered
vote is **skipped without error**. Aggregation is per-voter **last-write-wins** with empty-selection
withdrawal, identical to live votes — so a vote changed during the outage replaces the voter's prior
selection (US1, FR-008). The `PollVote` public shape is **unchanged**: the consumer cannot tell a
recovered vote from a live one, which is the point (SC-001 parity).

---

## Non-changes (explicit)

- **No new public type or field.** `IncomingMessage`, `PollVote`, `PollKeyset`, and all callbacks
  in `index.ts` are unchanged (FR-010, constitution III).
- **No new table, migration, or persisted field.** The consumer's keyset/credential storage is
  untouched.
- **No new event subscription.** `messaging-history.set` is still not handled; `syncFullHistory`
  stays `false` (FR-013, research Decision 5).
