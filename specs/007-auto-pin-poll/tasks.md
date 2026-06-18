---
description: "Task list for Auto-Pin the Availability Poll Until Game Time"
---

# Tasks: Auto-Pin the Availability Poll Until Game Time

**Input**: Design documents from `/specs/007-auto-pin-poll/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: REQUIRED. Constitution Principle II (Test-First, NON-NEGOTIABLE) + the spec's Testing
approach mandate service-boundary tests written before implementation. MVP poll-pin behaviour is
verified against the in-memory `FakeGateway` (no Baileys import); the deterministic `now` clock is
injected so the computed duration is asserted without a real-clock dependence. The pure
`selectPinDuration` bucket helper is **not** separately unit-tested — its return type is constrained
to the allowed literals by TypeScript, and its mapping is exercised end-to-end through the US1
duration assertions.

**Design confirmed (2026-06-18)**: "pin until game time" = compute `gameDate − now` seconds, then
select the **smallest** WhatsApp-supported bucket (`86400` / `604800` / `2592000`) that covers the
window (30d cap). User confirmed this approach. Bucketing lives **below** the Gateway seam.

**Organization**: Tasks grouped by user story. Priorities: US1 = P1 (MVP), US2 = P2, US3 = P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3
- All paths relative to repo root. Imports use `#src/*` subpaths + `.js` extensions (Constitution III).

## Path Conventions

Single project: `src/`, `tests/` at repo root (per plan.md Structure Decision). **No DB migration**,
**no new dependency** (`@whiskeysockets/baileys@7.0.0-rc13` already supports `{ pin, type, time }`).

---

## Phase 1: Setup

**Purpose**: Confirm preconditions; no installation needed.

- [X] T001 Confirm no dependency/schema change is required: `@whiskeysockets/baileys@7.0.0-rc13` already
  exposes the `sendMessage` `{ pin, type, time }` option (verified in research.md §1) and this feature
  adds no migration. Locate the touch points: `src/whatsapp-gateway/{types.ts,gateway.ts,index.ts}`,
  `src/whatsapp/gateway-port.ts`, `src/services/poll-service.ts`, `tests/helpers/fake-gateway.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared Gateway pin/unpin capability + the injectable clock seam. ALL user stories
depend on this phase (US1 needs `pinMessage`, US2 needs `unpinMessage`, US3 needs both best-effort).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Implement the pure helper `selectPinDuration(requestedSeconds): 86400 | 604800 | 2592000`
  (+ exported `PinDurationSeconds` type) in `src/whatsapp-gateway/messages/pin-duration.ts`: return the
  smallest bucket `≥ requestedSeconds`, `2592000` when `> 30d`, defensive `≤ 0` → `86400`. No Baileys
  import — pure arithmetic over the discrete set. (contracts/gateway-pin.md helper table.)
- [X] T003 [P] Add the `PinOutcome` type (`{ ok: true } | { ok: false; reason: 'network' | 'unknown';
  detail?: string }`) to `src/whatsapp-gateway/types.ts` and re-export it from
  `src/whatsapp-gateway/index.ts`. (data-model.md — mirrors `DeleteOutcome`.)
- [X] T004 Extend the `IWhatsAppGateway` port in `src/whatsapp/gateway-port.ts`: add
  `pinMessage(ref: MessageRef, durationSeconds: number): Promise<PinOutcome>` and
  `unpinMessage(ref: MessageRef): Promise<PinOutcome>`, and re-export `PinOutcome` (depends on T003).
- [X] T005 Implement `WhatsAppGateway.pinMessage` in `src/whatsapp-gateway/gateway.ts`: guard via
  `connectedSocket()`; resolve the message key (cached `MessageStore` key, else reconstruct
  `{ remoteJid: ref.groupId, fromMe: true, id: ref.id }` — same as `deleteMessage`); compute the
  bucket via `selectPinDuration(durationSeconds)`; send through `sendLimiter` →
  `sock.sendMessage(ref.groupId, { pin: key, type: proto.PinInChat.Type.PIN_FOR_ALL, time: bucket })`;
  return `{ ok: true }`, or classify a thrown send error into `{ ok: false, reason }` and log at warn
  (never throw on a send failure). (contracts/gateway-pin.md C1–C8; depends on T002, T003.)
- [X] T006 Implement `WhatsAppGateway.unpinMessage` in `src/whatsapp-gateway/gateway.ts`: same guard +
  key strategy + `sendLimiter`; send `{ pin: key, type: proto.PinInChat.Type.UNPIN_FOR_ALL }` (no
  `time`); return `PinOutcome`, never throwing on a send failure. (contracts/gateway-pin.md C9–C11;
  depends on T003; same file as T005 — sequential.)
- [X] T007 [P] Implement `pinMessage`/`unpinMessage` in the test double
  `tests/helpers/fake-gateway.ts`: record `pinnedMessages: { ref, durationSeconds }[]` and
  `unpinnedMessages: MessageRef[]`; add failure toggles `pinOutcomeOverride` / `unpinOutcomeOverride`
  (default `{ ok: true }`); include both in `reset()`. No Baileys import. (Depends on T004.)
- [X] T008 [P] Add the injectable clock seam to `PollService` in `src/services/poll-service.ts`:
  constructor gains `private readonly now: () => Date = () => new Date()` as the last parameter (after
  `keysetStore`), mirroring `FixtureService`. Backward-compatible default ⇒ no change at the
  `new PollService(...)` call sites in `daemon.ts` / `poll.ts` / `fixtures.ts`. (FR-008.)

**Checkpoint**: Gateway can pin/unpin (best-effort), the `FakeGateway` records pins/unpins, and
`PollService` has a deterministic clock. User stories can now begin.

---

## Phase 3: User Story 1 - Poll is pinned for its relevant window when posted (Priority: P1) 🎯 MVP

**Goal**: After the availability poll is posted, pin it for the window from now until game time.

**Independent Test**: Post a poll for a fixture whose `gameDate` is in the future (fixed injected
`now`); assert `FakeGateway.pinnedMessages` contains the new poll's `ref` with
`durationSeconds === floor((gameDate − now)/1000)`.

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL)

- [X] T009 [US1] Add integration tests to `tests/integration/whatsapp/poll-service.test.ts`: with a
  fixed injected `now` and a fixture `N` days out, `postOrReplaceNextPoll()` pins the **new** poll's
  ref with `durationSeconds = floor((gameDate − now)/1000)` (P1/P7); `previewNextPoll()` pins nothing
  (P8). (contracts/poll-pin-integration.md.)

### Implementation for User Story 1

- [X] T010 [US1] In `src/services/poll-service.ts` `postOrReplaceNextPoll`, after the keyset is
  persisted and `recordPollPosted` runs, compute
  `secondsUntilGame = Math.floor((game.gameDate.getTime() − this.now().getTime()) / 1000)` and call
  `await this.wa.pinMessage(ref, secondsUntilGame)` best-effort: on `{ ok: false }` log at warn
  (gameId / opponent / groupId / reason — no secrets) and continue; the `PostPollOutcome` is unchanged.
  Make T009 pass. (FR-002/FR-003/FR-004.)

**Checkpoint**: Newly posted polls are pinned for the correct window; posting flow otherwise unchanged.

---

## Phase 4: User Story 2 - Replacing a poll unpins the old one before removing it (Priority: P2)

**Goal**: On force-replace, unpin the superseded poll **before** deleting it, then pin the new poll.

**Independent Test**: Force-replace an existing poll; assert `unpinMessage(oldRef)` is recorded
**before** `deleteMessage(oldRef)`, the new poll is pinned, and this holds when the old delete returns
`{ ok: false }`.

### Tests for User Story 2 ⚠️ (write first, ensure they FAIL)

- [X] T011 [US2] Add integration tests to `tests/integration/whatsapp/poll-service.test.ts`: with an
  existing poll and `force: true`, the old poll is unpinned **before** it is deleted and the new poll
  is pinned (P3); with `FakeGateway.deleteOutcomeOverride = { ok: false, … }`, the old poll is still
  unpinned first and replacement completes (P4). (Same test file as T009 — sequential.)

### Implementation for User Story 2

- [X] T012 [US2] In `src/services/poll-service.ts` `removeExistingPoll`, call
  `await this.wa.unpinMessage({ id: poll.pollMessageId, groupId: poll.groupId })` **before**
  `this.wa.deleteMessage(...)`; on `{ ok: false }` log at warn and continue (best-effort). Order:
  delete DB rows → unpin → delete WhatsApp message. Make T011 pass. (FR-005.)

**Checkpoint**: Replacement never leaves a stale poll pinned, even when the delete fails.

---

## Phase 5: User Story 3 - Pinning and unpinning never block or break poll posting (Priority: P2)

**Goal**: A pin or unpin failure never aborts posting, replacement, recording, or vote tracking.

**Independent Test**: Force `pinOutcomeOverride` / `unpinOutcomeOverride` to `{ ok: false }`; confirm
the poll is still posted/replaced, the keyset persisted, and a subsequent vote still tracked.

### Tests for User Story 3 ⚠️ (write first, ensure they FAIL)

- [X] T013 [US3] Add integration tests to `tests/integration/whatsapp/poll-service.test.ts`: with
  `pinOutcomeOverride = { ok: false, reason: 'unknown' }`, `postOrReplaceNextPoll()` still returns
  `posted`, persists the keyset, stamps `lastPollPostedAt`, and a following `handlePollVote` is
  recorded (P2); with `unpinOutcomeOverride = { ok: false }` on replacement, the post still completes
  (P5). (Same test file as T009/T011 — sequential.)

### Implementation for User Story 3

- [X] T014 [US3] Harden the two call sites in `src/services/poll-service.ts` so pin/unpin are strictly
  best-effort: ensure neither a `{ ok: false }` outcome nor an unexpected rejection can abort the
  flow — wrap each call so a throw is caught + logged (defensive; the Gateway already returns outcomes
  rather than throwing on send failure, but the MVP must not depend on that). Make T013 pass. (FR-006.)

**Checkpoint**: All three stories independently functional; the poll is never lost to a pin/unpin fault.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T015 Run the typecheck + full test suite (`npm test`, `npm run typecheck` / `tsc --noEmit`) and
  confirm the new `IWhatsAppGateway` methods compile across all `PollService` call sites and the
  `FakeGateway`. Fix any fallout.
- [X] T016 Run quickstart.md validation (automated path): `npm test -- poll-service` passes; spot-check
  that logs on a forced pin failure are warn-level and contain no secrets.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **User Stories (Phases 3–5)**: All depend on Foundational. US1/US2/US3 are independently testable
  but their implementation tasks (T010, T012, T014) all edit `src/services/poll-service.ts`, and their
  tests (T009, T011, T013) all edit `poll-service.test.ts` — so run them **sequentially** (P1 → P2 →
  P2) rather than in parallel to avoid same-file conflicts.
- **Polish (Phase 6)**: After the desired stories are complete.

### Within Each Story

- Test task written and FAILING before its implementation task.
- US1: T009 → T010. US2: T011 → T012. US3: T013 → T014.

### Parallel Opportunities

- **Phase 2**: T003 (PinOutcome type), T007 (FakeGateway), and T008 (PollService clock) touch distinct
  files and are `[P]`. T002 (helper) is independent but feeds T005. T004 depends on T003; T005 → T006
  are the same file (gateway.ts, sequential) and depend on T002/T003.
- **Across stories**: limited — all implementation lands in `poll-service.ts` and all tests in
  `poll-service.test.ts`. Treat US1→US2→US3 as a sequence.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# These touch different files and can run together:
Task: "T003 Add PinOutcome type in src/whatsapp-gateway/types.ts (+ re-export from index.ts)"
Task: "T007 Implement pin/unpin in tests/helpers/fake-gateway.ts"
Task: "T008 Add injectable now clock to src/services/poll-service.ts"
# Then: T002 (helper) → T004 (port, after T003) → T005 → T006 (gateway.ts, sequential)
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup → 2. Phase 2: Foundational (CRITICAL — blocks all stories) → 3. Phase 3: US1.
4. **STOP and VALIDATE**: poll is pinned for the correct window. This alone delivers the feature's
   core value (poll stays visible until the game).

### Incremental Delivery

1. Setup + Foundational → gateway can pin/unpin best-effort.
2. US1 → polls pin on post → **MVP**.
3. US2 → replacement unpins-before-delete.
4. US3 → failure tolerance verified/hardened.

---

## Notes

- [P] = different files, no dependencies. Most implementation here is one file (`poll-service.ts`) +
  one gateway file, so parallelism is mostly within Phase 2.
- The discrete pin-duration set never leaves the gateway: MVP passes `secondsUntilGame`; the gateway
  picks the bucket (FR-007).
- Game time is always in the future (next-fixture selection guarantee) ⇒ a pin is always attempted on
  a successful post; the `≤ 0` branch in `selectPinDuration` is defensive only.
- Verify each test FAILS before implementing. Commit after each task or logical group.
