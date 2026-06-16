---

description: "Task list for feature 004 — Offline Catch-Up on Reconnect"
---

# Tasks: Offline Catch-Up on Reconnect

**Input**: Design documents from `/specs/004-offline-catch-up/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/dispatch-eligibility.md ✅

**Tests**: INCLUDED — FR-012 mandates automated tests at the Gateway boundary and constitution II
(Test-First) is NON-NEGOTIABLE. Test tasks are written first and must FAIL before implementation.

**Organization**: Tasks are grouped by user story. The relaxation is a single shared code change in
`handleMessagesUpsert`, so US1 and US2 share that production edit (US2 then adds the message-path
coverage); US3 (own-send claim) is a **precondition** sequenced before the relaxation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (maps to spec.md user stories)

## Path Conventions

Single-project library. All paths are repo-root-relative under `src/whatsapp-gateway/` and
`tests/unit/whatsapp-gateway/`.

---

## Phase 1: Setup

**Purpose**: Establish a known-green baseline before changing dispatch behaviour.

- [X] T001 Run `npm test` and confirm the Gateway unit suite (`tests/unit/whatsapp-gateway/*`) is green; record the baseline so behavioural changes in later phases are attributable.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the pure, type-agnostic dispatch-eligibility seam that all three stories rest
on (contracts/dispatch-eligibility.md C1). Additive only — does not yet change `gateway.ts`
behaviour, so the build stays green.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T002 Write failing unit tests for the pure dispatch-eligibility decision in `tests/unit/whatsapp-gateway/message-mapper.test.ts`: type-independence (G4 — same result for `type='notify'` and `type='append'` given equal inputs), authorization gate (G2 — unauthorized → not dispatchable), and claim gate (G3 — a failed `claim()` → not dispatchable). These replace the obsolete `isNewInbound` notify-only assertions.
- [X] T003 Add the pure `isDispatchable(authorized, claim)` decision function (type-agnostic, per contract C1) in `src/whatsapp-gateway/messages/message-mapper.ts` **alongside** the existing `isNewInbound` (do not remove `isNewInbound` yet — `gateway.ts` still references it until T008). Make T002 pass.

**Checkpoint**: The dispatch decision is a tested pure unit; `gateway.ts` is unchanged and the suite is green.

---

## Phase 3: User Story 3 - The Gateway's own sends are never mistaken for new inbound activity (Priority: P1) — PRECONDITION

**Goal**: Claim the Gateway's own `(chat, message-id)` at send time so its later echo (live or on
reconnect) is suppressed by the at-most-once guard — the protection that makes relaxing the gate
safe (FR-004).

**Independent Test**: Send a message and a poll via the Gateway; confirm a subsequent claim of the
same `(group, id)` is refused (echo would be suppressed) while an unclaimed id (a manual send) is
accepted.

### Tests for User Story 3

- [X] T004 [P] [US3] Write failing unit tests in `tests/unit/whatsapp-gateway/message-store.test.ts` for own-send-claim semantics (contract C2): after `claimOnce(messageStoreKey(group, id))`, a re-claim of the **same** key → `false` (echo suppressed, G5); an **unclaimed** id → `true` (manual operator send dispatched, G6, FR-006); the key is chat-scoped via `messageStoreKey` so sender PN/LID addressing is irrelevant (G7).

### Implementation for User Story 3

- [X] T005 [US3] Implement the own-send claim in `src/whatsapp-gateway/gateway.ts`: in `sendMessage` (immediately after `this.messageStore.set(sent)`, ~line 248) and in `sendPoll` (immediately after `this.messageStore.set(sent)`, ~line 333), call `this.messageStore.claimOnce(messageStoreKey(groupId, sent.key.id))` (FR-004, contract C2). Make T004 pass; full suite stays green.

**Checkpoint**: Own-send echoes are claimed at send time. The gate has NOT yet been relaxed, so behaviour is unchanged for the consumer — but the precondition for relaxation now holds.

---

## Phase 4: User Story 1 - Missed/changed poll votes are recovered after an outage (Priority: P1) 🎯 MVP

**Goal**: Process catch-up (`type='append'`) traffic on reconnect so votes cast or changed during
an outage update the tally (FR-001/FR-002). This phase lands the **shared relaxation** in
`handleMessagesUpsert`.

**Independent Test**: With a live poll, take the Gateway offline, add/change/withdraw votes from
another account, reconnect, and confirm the tally matches a never-offline run (quickstart §B).

### Tests for User Story 1

- [X] T006 [P] [US1] Write failing unit tests in `tests/unit/whatsapp-gateway/message-mapper.test.ts` for recovered-item eligibility/routing: a recovered (`type='append'`) authorized poll-update item is **dispatchable** and is identified as a poll vote (routes to the poll path); confirm `type` no longer affects the outcome (G1/G4).

### Implementation for User Story 1

- [X] T007 [US1] Rewire `handleMessagesUpsert` in `src/whatsapp-gateway/gateway.ts` to use `isDispatchable(...)` and **remove the notify-only gate** (the `if (!newInbound)` block, ~lines 466-471) (FR-001/FR-011). Preserve the ordering: authorization chokepoint → `claimOnce` → poll/text routing; keep `type` only as a debug log field. Then remove the now-unused `isNewInbound` from `message-mapper.ts` and its obsolete test references (FR-011).
- [X] T008 [US1] Confirm recovered-vote last-write-wins and withdrawal-as-empty-selection are covered by `tests/unit/whatsapp-gateway/poll-tally.test.ts`; add a "changed selection replaces prior" and a "withdrawal clears" case if not already present (FR-008). No production change expected (recovered votes reuse the live decrypt/aggregate path, research Decision 6). **Already covered** — `poll-tally.test.ts` "applies last-write-per-voter: a later selection replaces the earlier one" (changed vote) and "treats an empty selection as a withdrawal that removes the voter" (withdrawal); no new test or production code required.

**Checkpoint**: Recovered `append` poll votes flow through to `onPollVote` exactly once and apply correctly. MVP (votes fix — the reported defect) is functional.

---

## Phase 5: User Story 2 - Missed group messages are recovered after an outage (Priority: P2)

**Goal**: Recovered authorized-group **text** messages are dispatched to `onMessage` on reconnect,
exactly once, while non-authorized chats stay excluded (FR-002/FR-005). Rests on the Phase-4
relaxation (shared production change).

**Independent Test**: Take the Gateway offline, post messages in the authorized group and in a
different chat from another account, reconnect, and confirm only the authorized-group messages are
dispatched, each once (quickstart §C/§E).

### Tests for User Story 2

- [X] T009 [P] [US2] Write failing unit tests in `tests/unit/whatsapp-gateway/message-mapper.test.ts`: a recovered (`type='append'`) authorized **text** item is dispatchable and maps to `onMessage` (FR-001/FR-002, G1); a recovered `append` item from an **unauthorized** chat is dropped (FR-005, G2). (Same file as T006 — not parallel with it.)

### Implementation for User Story 2

- [X] T010 [US2] Verify the Phase-4 relaxation dispatches recovered authorized text messages to `onMessage` exactly once (claim guard, SC-002/SC-005) and rejects unauthorized chats (SC-004). Expect **no new production code** beyond T007; if a gap is found (e.g. a path that still consulted `type`), fix it in `src/whatsapp-gateway/gateway.ts`. Depends on T007. **Verified** — `handleMessagesUpsert` (`gateway.ts:489-517`) gates on `isDispatchable(authorized, claim)`, maps non-poll items via `mapIncomingMessage` → `dispatchMessage` → `onMessage`, the `claimOnce` guard enforces at-most-once, and unauthorized chats drop at the authorization gate. No path consults `type` for dispatch. No production change required.

**Checkpoint**: Both votes (US1) and messages (US2) are recovered on reconnect; cross-chat isolation and at-most-once hold.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T011 [P] Update the stale comments that describe the old rule to the relaxed dispatch rule: the `message-mapper.ts` header (lines ~6-8, "'append' = history/echo → NOT new inbound"), the `gateway.ts` `handleMessagesUpsert` doc/skip comments (~lines 427-433, 460-471), and any matching note in `src/whatsapp-gateway/README.md`.
- [X] T012 Run the full suite (`npm test`); confirm green within the project time budget and that the claim/dedup tests assert at-most-once across catch-up (SC-005). Confirm no MVP file imports Baileys (existing SC-011 guard still passes). **Done** — 236/236 tests pass in ~6.2s; `tests/unit/whatsapp-gateway/message-store.test.ts` asserts the own-send claim + at-most-once dedup; `tests/integration/whatsapp/no-baileys-import.test.ts` (SC-011) still passes.
- [ ] T013 Execute `specs/004-offline-catch-up/quickstart.md` manual validation (§B recovered votes, §C recovered messages, §D own-send echo + manual-send control, §E cross-chat isolation, §F clean reconnect unaffected) against a live test session; record outcomes. **REQUIRES OPERATOR** — needs a live WhatsApp-paired session (interactive QR pairing + reconnect), which is the ratified spec-002 manual-exclusion path and cannot be run from the automated harness. Awaiting operator execution.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. Adds the pure decision; BLOCKS all stories.
- **US3 (Phase 3)**: depends on Foundational. **Precondition** for the relaxation — must land before US1's gate removal so echoes never leak (FR-004 protects FR-001/FR-011).
- **US1 (Phase 4)**: depends on Foundational + US3. Lands the shared `handleMessagesUpsert` relaxation.
- **US2 (Phase 5)**: depends on US1 (shares the Phase-4 production change). Adds message-path tests + verification.
- **Polish (Phase 6)**: depends on US1 + US2.

### Within Each Story

- Tests are written first and must FAIL before implementation (constitution II).
- The pure decision (Foundational) precedes the `gateway.ts` wiring (US1).
- The own-send claim (US3) precedes the gate removal (US1).

### Parallel Opportunities

- T004 (US3, `message-store.test.ts`) can run in parallel with the Foundational/US tests in `message-mapper.test.ts` — different files.
- T006 and T009 both edit `message-mapper.test.ts` → **not** parallel with each other.
- T011 (comments) is [P] once code is final.

---

## Parallel Example

```bash
# After Foundational (T002–T003), the US3 test and the US1 mapper test touch different files:
Task: "T004 own-send-claim semantics tests in tests/unit/whatsapp-gateway/message-store.test.ts"
Task: "T006 recovered poll-vote eligibility tests in tests/unit/whatsapp-gateway/message-mapper.test.ts"
```

---

## Implementation Strategy

### MVP First (the reported defect)

1. Phase 1 Setup → green baseline.
2. Phase 2 Foundational → tested pure dispatch decision.
3. Phase 3 US3 → own-send claim (precondition).
4. Phase 4 US1 → relax the gate; recovered **votes** apply to the tally.
5. **STOP and VALIDATE**: quickstart §B (and §D for echo safety). This is the shippable MVP — the
   reported vote-loss defect is fixed (and message recovery comes along with the same relaxation).

### Incremental Delivery

1. Setup + Foundational + US3 → echo-safe foundation.
2. US1 → votes recovered (MVP). Validate → demo.
3. US2 → message recovery hardened + cross-chat/at-most-once verified. Validate → demo.
4. Polish → comments, full-suite gate, manual quickstart sweep.

---

## Notes

- The relaxation is **one** production edit in `handleMessagesUpsert`; US1 owns it and US2 verifies
  the message path through it — they are not fully independent by design (spec: US2 is "the same
  mechanism applied to the text path").
- US3 must precede US1's gate removal, or echoes would leak on relaxation.
- No schema, storage, dependency, or public-surface change (FR-010, data-model.md "Non-changes").
- The live-socket reconnect path is validated manually (quickstart), per the ratified spec-002
  exclusion for interactive WhatsApp paths.
