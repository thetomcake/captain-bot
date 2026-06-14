# Implementation Plan: Standalone WhatsApp Gateway Library

**Branch**: `002-whatsapp-gateway` | **Date**: 2026-06-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-whatsapp-gateway/spec.md`

## Summary

Build a **self-contained WhatsApp Gateway library** inside the project (`src/whatsapp-gateway/`) that hides all Baileys complexity behind one small, stable, well-documented, well-tested interface. It owns authentication (+ forced re-auth), connection/reconnection classification, group listing, send/receive, native polls, **poll-vote decryption and tally**, deletion, encryption hand-off, single-group restriction, and **JID/LID identity canonicalization**. The MVP will later consume it through a single facade; this spec delivers the library standalone, validated via **one manual entry point per action** (no shared CLI/arg-parsing layer).

The decisive technical approach: keep all hard logic in **pure, injectable units** (disconnect classifier, reconnect policy, identity resolver, poll-vote aggregator, message mapper, group filter, poll-option validator, vote decryptor) that are unit-tested with real inputs and no live socket; the thin Baileys-bound shell (`gateway.ts`) wires those units to the socket and is validated manually. All Baileys usage is written against the **exact pinned version's verified behaviour** — notably `7.0.0-rc13`, where built-in poll-vote auto-decryption is disabled, so the Gateway decrypts votes itself.

## Technical Context

**Language/Version**: TypeScript (strict, no `any`) on Node.js 22.x. ESM with NodeNext resolution; `.js` extensions on relative imports; `#src/*` subpath imports per constitution. (Baileys v7 is ESM-only and requires Node 20+ — satisfied.)

**Primary Dependencies**:
- `@whiskeysockets/baileys` — **pinned to the exact installed version `7.0.0-rc13`** (the wrapped protocol library). Pin exactly (no `^`) because v7 is an RC and behaviour shifts between RCs (see research.md).
- `qrcode-terminal` + `qrcode` (already in the project) — QR rendering inside the manual entry points only, not in the library core.
- No other runtime dependencies introduced. The library reuses the existing `RateLimiter` pattern (`p-queue`-backed) but as its own copy/util to stay decoupled from MVP code.

**Storage**: **None owned by the library — fully storage-agnostic.** The Gateway holds auth state in memory only and never touches the filesystem or a database. The consumer optionally passes an **opaque, serialized credential snapshot** (`WhatsAppCredentials`) into the constructor; whenever credentials change the library invokes a consumer-supplied `onCredentialsUpdate(snapshot)` callback (and exposes `getCredentials()`), so the consumer persists the snapshot however it likes (DB, file, secret store) and passes it back next time. The snapshot is opaque (library serializes Baileys `creds`+`keys` via `BufferJSON` internally). **Polls follow the same pattern**: `sendPoll` returns a `PollKeyset` (the per-poll `messageSecret` + options) the consumer persists; to decrypt a later vote the library asks for it via the `resolvePollKeyset` callback (no keyset ⇒ skip, no error). The library keeps no durable poll state and **no durable tally** — it emits per-voter `PollVote` events and the consumer aggregates. An in-memory message cache may exist only for Baileys send-retries. This gives **zero infrastructure coupling**, satisfying FR-002 (no MVP dependency) and FR-008 (standalone).

**Testing**: Vitest. Unit tests target the **pure units at the library's own interface boundary** — never `vi.mock('@whiskeysockets/baileys')` (consistent with `tests/README.md` and the MVP's existing rule). Socket-bound orchestration (QR pairing, live connection, live votes) is **interactive hardware**, excluded from the automated suite per constitution and validated through the manual entry points. Target: full new unit suite runs in well under the project's existing fast-suite budget.

**Target Platform**: Node.js 22 library + executable entry-point scripts (Linux/macOS), long-running for `listen`/`watch-votes`.

**Project Type**: Internal library (single project) with per-action manual entry points.

**Performance Goals**: Not throughput-bound. Constraints that matter: conservative send rate (≤5 messages/minute), reconnect on a bounded backoff schedule, fast unit suite.

**Constraints**:
- ESM-only; pinned Baileys version; verify every Baileys behaviour against the installed source/version-matched docs (FR-031) — invent nothing.
- Must **not** modify or import current MVP modules (`src/whatsapp/`, services, schema). Lives in its own `src/whatsapp-gateway/` tree.
- Conservative WhatsApp rate limiting to reduce ban risk; single-group authorization enforced.
- No credentials in tests; the library never persists session state — it returns an opaque snapshot for the consumer to store; nothing is committed.

**Scale/Scope**: Single WhatsApp account, one (configurable to a few) authorized group(s), low message volume. Not multi-tenant, not high-throughput.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. CLI-First ✅ PASS
The library is consumed programmatically, but every action ships a **single-purpose executable entry point** that reads inline/env config and writes human-readable results to stdout and errors to stderr — composable and debuggable. No interactive prompt libraries. JSON-friendly output where it aids scripting (e.g., `list-groups`).

### II. Test-First (NON-NEGOTIABLE) ✅ PASS
Pure units (disconnect classifier, reconnect policy, identity resolver, poll-tally reducer, message mapper, group filter, poll-option validator) have tests written first against real inputs. Mocking is at the library's **own service boundary**, never at the Baileys library boundary (`tests/README.md`). Interactive socket paths (QR auth, live votes) are excluded from the automated suite — the same, already-ratified exclusion the MVP applies to its `WhatsAppClient` — and covered by the manual entry points + quickstart instead.

### III. TypeScript ✅ PASS
Strict mode, no `any`; NodeNext module resolution; `.js` extensions on relative imports; `#src/*` subpath imports (no `../../../`). Baileys v7's ESM-only shape aligns with the project's NodeNext ESM. Library exposes complete, accurate types and hides all Baileys types from consumers.

### IV. Security-First (NON-NEGOTIABLE) ✅ PASS
Session credentials are never persisted by the library — they are returned to the consumer as an opaque snapshot to store securely — and never placed in tests or committed; single authorized-group enforcement (no access to other chats); poll-option and input validation; deletion is best-effort and cannot crash the process; benign offline-sync decryption noise is tolerated without weakening any security control. End-to-end encryption is delegated to Baileys' Signal implementation; the only crypto the Gateway performs itself is the documented poll-vote decryption.

**Result: All gates pass. No entries in Complexity Tracking.**

## Project Structure

### Documentation (this feature)

```text
specs/002-whatsapp-gateway/
├── plan.md              # This file
├── research.md          # Phase 0 — pinned-version Baileys reference + decisions
├── data-model.md        # Phase 1 — entities & state machines
├── quickstart.md        # Phase 1 — manual per-entry-point validation guide
├── contracts/           # Phase 1 — public library interface + entry-point contract
│   ├── gateway-interface.md
│   └── entry-points.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/whatsapp-gateway/                # NEW, self-contained; does not touch src/whatsapp/ (MVP)
├── index.ts                         # Public surface: WhatsAppGateway + domain types
├── gateway.ts                       # Baileys-bound orchestration shell (manual-validated)
├── types.ts                         # Public domain types (no Baileys types leak out)
├── config.ts                        # GatewayConfig (authorized groups, rate, store)
├── connection/
│   ├── disconnect-classifier.ts     # PURE: status code → recover | terminal | restart
│   └── reconnect-policy.ts          # PURE: bounded backoff schedule + restart-handshake cap
├── auth/
│   ├── credentials.ts               # PURE: (de)serialize creds+keys ↔ opaque WhatsAppCredentials snapshot
│   └── auth-state.ts                # Build in-memory AuthenticationState from a snapshot; emit onCredentialsUpdate
├── messages/
│   ├── message-mapper.ts            # PURE: WAMessage → Message; notify vs append handling
│   └── message-store.ts             # Best-effort in-memory cache for send-retries (getMessage); NOT on the vote path
├── groups/
│   └── group-filter.ts              # PURE: authorized-group restriction + isJidGroup guard
├── identity/
│   └── identity-resolver.ts         # PURE: JID/LID (+device) → canonical identity
├── polls/
│   ├── poll-options.ts              # PURE: validate 2–12 options, selectableCount
│   ├── poll-vote-decryptor.ts       # Decrypt a vote from a consumer-supplied PollKeyset; #2342 try-both LID/PN fallback
│   └── poll-tally.ts                # PURE: aggregateVotes(PollVote[]) → PollResult (optional consumer helper)
└── bin/                             # One entry point per action — NO shared arg parser
    ├── connect.ts
    ├── force-reauth.ts
    ├── list-groups.ts
    ├── send-message.ts
    ├── listen.ts
    ├── send-poll.ts
    ├── watch-votes.ts
    └── delete-message.ts

tests/unit/whatsapp-gateway/         # NEW; pure-unit tests, no live socket, no Baileys mock
├── disconnect-classifier.test.ts
├── reconnect-policy.test.ts
├── identity-resolver.test.ts
├── message-mapper.test.ts
├── group-filter.test.ts
├── poll-options.test.ts
├── poll-tally.test.ts
└── credentials.test.ts             # snapshot serialize → deserialize round-trip (pure)
```

**Structure Decision**: New isolated subtree `src/whatsapp-gateway/` so the library is fully decoupled from the MVP (`src/whatsapp/`, services, `database/schema.ts`) — satisfying FR-002. The Baileys-touching surface is confined to `gateway.ts`, `auth/auth-state.ts`, and `polls/poll-vote-decryptor.ts`; everything else (including credential snapshot serialization) is pure and unit-tested. The library owns no storage — credentials are returned to the consumer to persist. Entry points in `bin/` are thin, single-action, and import only the library's public surface (`index.ts`), proving SC-001.

## Complexity Tracking

> No constitution violations — section intentionally empty.
