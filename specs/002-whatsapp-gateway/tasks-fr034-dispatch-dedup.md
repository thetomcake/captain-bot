# Tasks: At-most-once message dispatch (FR-034)

**Feature**: WhatsApp Gateway (spec 002) — addendum
**Spec**: [spec.md](./spec.md) → FR-034 + "Re-delivery of a live message" edge case
**Plan reference**: bug review 2026-06-16 — a single `!postpoll` was re-delivered (decrypt-retry → session re-establishment), dispatched twice, posted two polls, and tripped `UNIQUE constraint failed: polls.game_id`.

> Scope is a self-contained internal change to the Gateway dispatch layer. No public-surface change
> (`src/whatsapp-gateway/index.ts` unchanged), so `data-model.md` / `contracts/` / `quickstart.md`
> are unaffected. This is **not** part of the 003 MVP task list and does not modify `tasks.md`.

## Design recap

`handleMessagesUpsert` calls `messageStore.set(msg)` first and unconditionally (`gateway.ts:443`)
for every upsert item — including non-dispatched `append`/history and outbound echoes. So the
content cache cannot serve as the "seen" check. Dedup uses a **separate, dispatched-only** bounded
set inside `MessageStore`, consulted only for messages that pass the live + authorized gates, and
covering both the `onMessage` and `onPollVote` routing paths.

---

## Phase 1: Test-first (Constitution II — NON-NEGOTIABLE)

- [X] T001 Add unit tests for `MessageStore.claimDispatch` in `tests/unit/whatsapp-gateway/message-store.test.ts`: (a) first call for a key returns `true`; (b) a second call for the same key returns `false`; (c) two distinct keys both return `true`; (d) past `maxSize` distinct claims, the oldest key is evicted and re-claimable. Verify the tests fail before T002.

## Phase 2: Implementation

- [X] T002 Implement `claimDispatch(key: string): boolean` in `src/whatsapp-gateway/messages/message-store.ts` — backed by a new bounded, insertion-ordered `dispatched` Set kept separate from the content `entries` map; return `true` only the first time a key is claimed, evict the oldest beyond `maxSize`. Make T001 pass.
- [X] T003 Add the dedup guard in `handleMessagesUpsert` in `src/whatsapp-gateway/gateway.ts` — after the `newInbound` + `authorized` gates pass and before the `pollUpdateMessage` / `onMessage` split, compute `messageStoreKey(remoteJid, msg.key?.id)` and, when `msg.key?.id` is present, `continue` (with a debug log) if `messageStore.claimDispatch(key)` returns `false`. Leave the unconditional `messageStore.set(msg)` at line 443 unchanged (it backs send-retries independently).

## Phase 3: Validation

- [X] T004 Run the unit suite (`npm test`) and the no-Baileys-import / type checks; confirm green and the full suite still meets the fast-suite target. The gateway-class dispatch wiring itself is validated manually via `src/whatsapp-gateway/bin/listen.ts` (FR-033: the Gateway class is exercised through the manual entry points, not the unit suite) — send a message and confirm a single dispatch.

---

## Dependencies

- T001 → T002 (test before implementation).
- T002 → T003 (`gateway.ts` consumes the new `MessageStore` method).
- T003 → T004 (validate after wiring).
- Strictly sequential; no `[P]` parallelism (single small change, shared files).

## Out of scope (noted, not addressed here)

The residual TOCTOU race in `PollService.postOrReplaceNextPoll` (throttle stamped only after send;
send-before-persist) is no longer *reachable* via re-delivery once FR-034 lands; the
`polls.game_id` UNIQUE constraint remains the backstop. Hardening that path is a separate change.
