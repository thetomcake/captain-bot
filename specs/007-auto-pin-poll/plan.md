# Implementation Plan: Auto-Pin the Availability Poll Until Game Time

**Branch**: `007-auto-pin-poll` | **Date**: 2026-06-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-auto-pin-poll/spec.md`

## Summary

When the availability poll is posted for the next fixture, pin it in the group so it stays at the
top until the match, and on replacement unpin the superseded poll before deleting it. Two thin,
best-effort capabilities are added to the WhatsApp Gateway (feature 002) — **pin** and **unpin** —
and the existing poll-posting flow (features 003/006) is wired to call them.

The one non-obvious technical fact (confirmed against the installed Baileys `7.0.0-rc13` source —
the official website does not document pinning) is that **WhatsApp pin durations are discrete**: the
only accepted values are **24h (86400s), 7d (604800s), or 30d (2592000s)**. "Pin until game time"
is therefore implemented as: compute the seconds remaining (`gameDate − now`), then select the
**smallest supported bucket that still covers the window** (FR-004 + spec's documented granularity
assumption). This bucketing is a Baileys/platform detail, so it lives **below** the Gateway seam (a
pure, unit-tested `pin-duration` helper) — the MVP passes a plain "seconds until kick-off" and never
sees the discrete set, preserving the "MVP never touches Baileys" boundary (FR-007).

**Technical approach**:

- **Gateway (002)** gains `pinMessage(ref, durationSeconds)` and `unpinMessage(ref)` on its public
  surface and on the `IWhatsAppGateway` port. Both reuse the existing best-effort send machinery
  (`connectedSocket()` guard, `sendLimiter`, cached-key-or-reconstruct from `deleteMessage`) and
  return a `PinOutcome` that **never throws** (mirrors `DeleteOutcome`). `pinMessage` issues
  `sock.sendMessage(jid, { pin: key, type: PIN_FOR_ALL, time: <bucket> })`; `unpinMessage` issues
  `{ pin: key, type: UNPIN_FOR_ALL }`. Bucket selection is the pure `selectPinDuration()`.
- **MVP (003/006)** — `PollService` gains an injectable `now: () => Date` clock (FR-008, mirroring
  `FixtureService`). After a successful `sendPoll`, it computes `secondsUntilGame` and calls
  `pinMessage` best-effort (log on failure). In `removeExistingPoll` it calls `unpinMessage`
  **before** `deleteMessage` so a failed delete never leaves the old poll pinned (FR-005). Game time
  is always in the future (next-fixture selection guarantees it), so the window is always positive.

No schema change, no new dependency, no new persisted state. The `FakeGateway` test double gains
matching `pinMessage`/`unpinMessage` recording + failure toggles.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ≥ 22, ESM (`"type": "module"`)

**Primary Dependencies**: existing `@whiskeysockets/baileys@7.0.0-rc13` (pin support already present —
`{ pin, type, time }` send option), in-repo WhatsApp Gateway via `IWhatsAppGateway` port, drizzle-orm
+ better-sqlite3 (unchanged). **No new dependencies.**

**Storage**: SQLite via Drizzle. **No schema change** — the pin/unpin are transient WhatsApp
side-effects; nothing new is persisted (the existing `polls` row + keyset are untouched).

**Testing**: Vitest. Service-boundary mocking per `tests/README.md`: MVP poll-pin behaviour verified
against the in-memory `FakeGateway` (records pins/unpins + failure toggles, imports no Baileys); the
pure `selectPinDuration()` bucketing tested directly; the deterministic `now` clock is injected so
the computed duration is asserted without real-clock dependence. The Gateway's pin/unpin send wiring
is the thin Baileys-bound shell (manually validated, consistent with how `sendMessage`/`deleteMessage`
are treated) — the testable logic (bucket selection, best-effort outcome classification) is extracted
into pure units.

**Target Platform**: Linux/macOS CLI (single-operator) + long-running `daemon`.

**Project Type**: Single project (CLI + services + scraping + WhatsApp gateway), structure unchanged.

**Performance Goals**: Not performance-sensitive; one extra rate-limited send per poll post.

**Constraints**: Constitution NodeNext + `.js` import extensions + `#src/*` subpath imports;
pin/unpin MUST be best-effort and never abort poll posting/replacement (FR-006); MVP requests
pin/unpin only through `IWhatsAppGateway`, never Baileys (FR-007); "now" injectable for deterministic
duration tests (FR-008); the discrete pin-duration set is encapsulated below the Gateway seam.

**Scale/Scope**: One poll per fixture; one authorized group; one extra send (pin) per post and one
extra send (unpin) per replacement.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| **I. CLI-First** | No new command. Behaviour rides the existing `!postpoll` trigger / `poll` CLI / `daemon`, all unchanged in surface. Pin/unpin are internal side-effects of posting. | ✅ PASS |
| **II. Test-First (NON-NEGOTIABLE)** | Tasks ordered tests-first. Behaviour verified at the `IWhatsAppGateway` boundary via `FakeGateway` (pin applied with correct duration; unpin-before-delete on replacement; pin/unpin failure never aborts posting). Pure `selectPinDuration()` unit-tested for each bucket boundary. Asserts FR-/SC- (WHAT), not Baileys internals (HOW). Uses the standard helpers + service-boundary mocking from `tests/README.md`. | ✅ PASS |
| **III. TypeScript** | All code TypeScript strict; NodeNext; relative imports carry `.js`; `#src/*` subpath imports; no `../../../`. `time` bucket typed to Baileys' `86400 \| 604800 \| 2592000` literal. | ✅ PASS |
| **IV. Security-First (NON-NEGOTIABLE)** | No new credentials, no auth change. Pin/unpin act only within the already-authorized group (the gateway guards via `connectedSocket()`); no secrets logged (pin logs record ref id/group/duration/reason only). Rate-limited like other sends to keep ban-risk profile unchanged. | ✅ PASS |

**Result**: PASS — no violations. Complexity Tracking not required.

*Post-Phase-1 re-check*: PASS — the design adds two thin gateway methods + one pure helper and wires
two best-effort calls into the existing poll flow; no new architecture, schema, dependency, or
command. Gates still hold.

## Project Structure

### Documentation (this feature)

```text
specs/007-auto-pin-poll/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output — Baileys pin/unpin API for rc13 + discrete durations
├── data-model.md        # Phase 1 output — PinOutcome + duration buckets (no DB change)
├── quickstart.md        # Phase 1 output — manual + automated validation
├── contracts/           # Phase 1 output
│   ├── gateway-pin.md          # Gateway pinMessage/unpinMessage behavioural contract
│   └── poll-pin-integration.md # MVP poll-posting pin/unpin-on-replace contract
├── checklists/
│   └── requirements.md  # (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── whatsapp-gateway/                 # Feature 002 (the gateway library)
│   ├── types.ts                      # MODIFY: add PinOutcome; export it
│   ├── gateway.ts                    # MODIFY: add pinMessage()/unpinMessage() (best-effort sends)
│   ├── index.ts                      # MODIFY: re-export PinOutcome on the public surface
│   └── messages/
│       └── pin-duration.ts           # NEW (pure): selectPinDuration(seconds) → 86400|604800|2592000
├── whatsapp/
│   └── gateway-port.ts               # MODIFY: add pinMessage/unpinMessage to IWhatsAppGateway;
│                                     #   re-export PinOutcome
└── services/
    └── poll-service.ts               # MODIFY: inject now() clock; pin new poll after send (FR-002/004);
                                      #   unpin-before-delete in removeExistingPoll (FR-005)

tests/
├── helpers/
│   └── fake-gateway.ts               # MODIFY: implement pinMessage/unpinMessage; record + failure toggles
├── unit/
│   └── whatsapp-gateway/
│       └── pin-duration.test.ts      # NEW: bucket-boundary selection (24h/7d/30d, >30d cap)
└── integration/
    └── whatsapp/
        └── poll-service.test.ts      # MODIFY/EXTEND: poll pinned with correct duration; unpin-before-
                                      #   delete on replace; pin/unpin failure never aborts the post
```

**Structure Decision**: Single-project layout (existing). One new pure module (`pin-duration.ts`)
inside the gateway, two new gateway methods, and targeted edits to the port, the `FakeGateway`, and
`poll-service.ts`. No schema migration, no new CLI command.

## Complexity Tracking

> No Constitution Check violations — section intentionally empty.
