# Implementation Plan: Offline Catch-Up on Reconnect

**Branch**: `004-offline-catch-up` | **Date**: 2026-06-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-offline-catch-up/spec.md`

## Summary

The WhatsApp Gateway (`src/whatsapp-gateway/`, spec 002) currently discards everything WhatsApp
re-delivers on reconnect after an outage: its inbound dispatcher gates on the Baileys upsert
`type`, dispatching only live `'notify'` items and dropping `'append'` items
(`gateway.ts:466-471`, via `isNewInbound()` in `message-mapper.ts:36-38`). Offline catch-up
arrives as `'append'` (confirmed in the installed Baileys: `messages-recv.js:1432` upserts a
message as `node.attrs.offline ? 'append' : 'notify'`), so it is thrown out along with
own-send echoes and the (already-disabled) history backfill.

**Technical approach**: relax the dispatch criterion (FR-011) so it no longer gates on the
live/not-live tag, and instead lets every item through the **existing single authorization
chokepoint** (`gateway.ts:472-481`) followed by the **existing at-most-once guard**
(`claimOnce`, `message-store.ts:44-57`). The echo-suppression role the notify-only gate used to
serve is moved to a one-line **own-send claim at send time** (FR-004): `sendMessage`/`sendPoll`
already hold `sent.key.id` + `groupId` and already call `messageStore.set(sent)`
(`gateway.ts:248`, `:333`), so claiming `(groupId, sent.key.id)` there makes the later echo
fail `claimOnce` and be suppressed — live or on reconnect. Poll-vote decryption, the durable
keyset fallback, per-voter last-write-wins aggregation, the authorized-group filter, and the
benign-replay (`MessageCounterError`) tolerance are all **unchanged** and simply now also run for
recovered items. Bulk older-history sync stays off (`syncFullHistory: false`, no
`messaging-history.set` handler) so catch-up cannot over-reach into full history (FR-013).

The per-item dispatch decision is **extracted into a pure function** so the five FR-012 scenarios
(recovered new vote, recovered changed vote, recovered authorized message, suppressed own-send
echo, rejected unauthorized-chat item) are unit-testable at the same granularity as the existing
`isNewInbound`/`claimOnce` tests — honouring the test-first, service-boundary standard without a
live socket.

## Technical Context

**Language/Version**: TypeScript (strict, no `any`) on Node.js 22.x. ESM with NodeNext
resolution; `.js` extensions on relative imports; `#src/*` subpath imports (constitution III).

**Primary Dependencies**: `@whiskeysockets/baileys` 7.0.0-rc13 (transitive, Gateway-internal
only — no MVP file imports it, SC-011). No new dependencies; no dependency version change.

**Storage**: N/A for this feature. The Gateway is stateless across restarts; the consumer's
existing durable poll-keyset store (the restart-proof decryption fallback,
`config.resolvePollKeyset`) and credential snapshot are unchanged (FR-010). The at-most-once
guard and own-send claim are in-memory by design (best-effort window, FR-034).

**Testing**: Vitest. Pure-unit tests for the extracted dispatch-decision function and the
own-send-claim semantics (mirrors `tests/unit/whatsapp-gateway/message-mapper.test.ts` and
`message-store.test.ts`); service-boundary philosophy per `tests/README.md` — no Baileys-internal
mocking. The live-socket reconnect path itself is validated manually via the Gateway's `bin/`
entry points + `quickstart.md` (the same ratified exclusion spec 002 uses for interactive paths).

**Target Platform**: Single Linux/macOS server, single operator, long-running daemon.

**Project Type**: Single-project library (the in-repo WhatsApp Gateway) consumed by a CLI.

**Performance Goals**: Not throughput-bound. A large reconnect backlog must complete without
crashing and without double-dispatch (SC-005); the existing `claimOnce` LRU window
(`DEFAULT_MAX_SIZE = 1000`) absorbs burst re-deliveries (Assumption: window sufficient, FR-034).

**Constraints**:
- Zero cross-chat leakage preserved — the single authorization chokepoint stays the only gate
  both the text and poll-vote paths trust (FR-005/SC-004).
- At-most-once dispatch preserved across catch-up (FR-003/SC-002/SC-005).
- No consumer-side change required (FR-010); the MVP keeps its existing keyset/credential state.
- Bulk older-history sync remains disabled and unconsumed (FR-013).

**Scale/Scope**: One authorized group, one operator, low message volume; a multi-hour outage
produces at most a few hundred catch-up items — well within the dedup window.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. CLI-First ✅ PASS
No CLI surface change. Behaviour is exercised through the Gateway library consumed by the existing
`daemon`/`bin/` commands; manual validation uses `bin/listen.ts` + `bin/watch-votes.ts` which
already write human-readable output to stdout.

### II. Test-First (NON-NEGOTIABLE) ✅ PASS
The dispatch decision is extracted into a pure function and the five FR-012 scenarios are written
as failing unit tests first, then made to pass — same seam and granularity as the existing
`message-mapper`/`message-store` unit tests. Mocking stays at the project's own boundaries (pure
functions + the in-memory `MessageStore`); no `vi.mock('@whiskeysockets/baileys')`. The live
reconnect path is validated via `bin/` + quickstart, not the automated suite (ratified spec-002
exclusion for interactive WhatsApp paths).

### III. TypeScript ✅ PASS
Strict, no `any`; NodeNext ESM; `.js` extensions; `#src/*` imports. The change stays inside the
Gateway and behind its existing public surface — no Baileys type crosses into MVP code, and the
public `IncomingMessage`/`PollVote`/callback types are unchanged.

### IV. Security-First (NON-NEGOTIABLE) ✅ PASS
Relaxing the live-only gate does **not** weaken authorization: the single-authorized-group
chokepoint is unchanged and remains the sole dispatch gate (FR-005). No credential handling
changes. Recovered chat input stays untrusted and flows through the same decrypt/parse paths as
live input. The own-send claim is an identity/dedup record, not a security control, and adds no
new trust surface. No test uses real credentials or bypasses the group filter.

**Result: All gates pass. Complexity Tracking is empty.**

## Project Structure

### Documentation (this feature)

```text
specs/004-offline-catch-up/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 — Baileys append/offline confirmation + OQ resolutions
├── data-model.md        # Phase 1 — conceptual entities (no schema/storage change)
├── quickstart.md        # Phase 1 — manual reconnect/catch-up validation guide
├── contracts/
│   └── dispatch-eligibility.md  # Phase 1 — the new inbound-dispatch rule + own-send claim contract
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/whatsapp-gateway/
├── gateway.ts                      # CHANGE — handleMessagesUpsert: drop the notify-only gate
│                                   #   (FR-001/FR-011); call the extracted dispatch-decision.
│                                   #   sendMessage/sendPoll: claim (groupId, sent.key.id) at
│                                   #   send time (FR-004) right after messageStore.set(sent).
├── messages/
│   ├── message-mapper.ts           # CHANGE — retire/repurpose isNewInbound (FR-011); add the
│   │                               #   pure dispatch-decision (authorized + claim, type-agnostic).
│   └── message-store.ts            # REUSE — claimOnce/messageStoreKey unchanged (FR-003 guard).
├── groups/group-filter.ts          # REUSE — authorization chokepoint unchanged (FR-005).
├── polls/poll-vote-decryptor.ts    # REUSE — recovered votes decrypt via the same flow (FR-007).
├── polls/poll-tally.ts             # REUSE — per-voter last-write-wins for recovered votes (FR-008).
└── (connection/*, identity/*, config.ts, types.ts, index.ts)  # UNCHANGED public surface.

tests/unit/whatsapp-gateway/
├── message-mapper.test.ts          # CHANGE — replace notify-only assertions with the new
│                                   #   dispatch-decision scenarios (recovered append IS eligible,
│                                   #   unauthorized rejected, echo suppressed via claim).
├── message-store.test.ts           # REUSE/EXTEND — own-send claim then echo claimOnce → false.
└── (new) own-send-claim or fold into the above — FR-012 coverage of the five scenarios.
```

**Structure Decision**: This is a contained behavioural change inside the existing single-project
Gateway library. No new modules, directories, dependencies, or storage. The only structural move
is extracting the per-item dispatch decision out of `handleMessagesUpsert` into a pure function in
`message-mapper.ts` (where `isNewInbound` already lives), so the FR-012 scenarios are unit-testable
without instantiating a live socket — matching the codebase's existing pure-unit test seams.

## Complexity Tracking

> No constitution violations — section intentionally empty.
