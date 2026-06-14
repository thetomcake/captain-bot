# Quickstart & Validation Guide: WhatsApp Gateway Library

**Feature**: 002-whatsapp-gateway
**Date**: 2026-06-14

## Overview

This guide proves the Gateway works end-to-end. It has two parts:
1. **Automated unit validation** — the pure units, run with Vitest, no live WhatsApp.
2. **Manual per-action validation** — one entry point per action against a real WhatsApp account (interactive paths excluded from the automated suite per constitution).

See [contracts/gateway-interface.md](./contracts/gateway-interface.md) for the API, [contracts/entry-points.md](./contracts/entry-points.md) for each script, [data-model.md](./data-model.md) for types, and [research.md](./research.md) for the pinned-version Baileys behaviour.

---

## Prerequisites

- Node.js 22.x, project dependencies installed (`npm install`).
- `@whiskeysockets/baileys` pinned to the exact installed version (`7.0.0-rc13`) — do not float with `^`.
- A WhatsApp account on a phone you can scan a QR with, and a test group whose JID you can obtain (via `list-groups`).
- A scratch credentials file the **entry points** (the consumer) own — the library stores nothing itself. E.g. `export WA_CREDS_FILE=./.wa-creds.json` (git-ignored).

---

## Part 1 — Automated unit validation

```bash
npx vitest run tests/unit/whatsapp-gateway
```

**Expected**: all pass, no live connection, completes within the project's fast-suite budget. These tests use **real inputs** at the library's own boundary and **never** `vi.mock('@whiskeysockets/baileys')`.

| Unit under test | What it proves | FRs |
|-----------------|----------------|-----|
| `disconnect-classifier` | Each status code → `restart`/`recover`/`terminal`; `408` ambiguity → `recover`; `401/403/411/500` → `terminal`; `515` → `restart` | FR-011, FR-010 |
| `reconnect-policy` | Backoff is bounded, jittered, capped; restart-handshake cap honoured | FR-010, FR-011 |
| `identity-resolver` | LID and PN forms of one person → one `canonicalId`; device suffix stripped; no double-identity | FR-025, FR-026 |
| `message-mapper` | `notify` → `IncomingMessage` (incl. the operator's own manual messages — they are a participant); `append` (own programmatic-send echo / history) not reported; text from `conversation`/`extendedTextMessage` | FR-014, FR-015 |
| `group-filter` | Only authorized group(s) pass; non-group / other chats rejected | FR-017, FR-018 |
| `poll-options` | Rejects <2 or >12 options and empty options; accepts valid specs | FR-020 |
| `poll-tally` | Pure `aggregateVotes(PollVote[])`: last-write-per-voter, withdrawal removes the voter, per-option voters canonicalized with no LID/PN double-count | FR-022, FR-023, FR-026 |
| `credentials` | Snapshot round-trip: `serialize(state)` → `deserialize(snapshot)` ≡ original (incl. Buffers and v7 `lid-mapping`/`device-list`/`tctoken` keys) | FR-006, FR-008 |

---

## Part 2 — Manual validation (real account)

> Run each with `tsx`. Interactive (QR) and live-vote paths are validated here, not in the suite. Each script persists the opaque credential snapshot to `WA_CREDS_FILE` itself (consumer-side) — the library never writes to disk.

### Scenario A — Connect, persist, reconnect (US1)
```bash
WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/connect.ts
```
**Expect**: QR prints on first run → after scanning, `connected`, and `./.wa-creds.json` is written by the script. Stop and re-run → `connected` with **no** QR (snapshot resumed from the file). Briefly drop the network → it reconnects automatically on the backoff schedule.
**Pass**: FR-005, FR-006, FR-008, FR-009, FR-010, FR-011 / SC-002, SC-003.

### Scenario B — Forced re-auth (US1)
```bash
WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/force-reauth.ts
# then:
WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/connect.ts
```
**Expect**: re-auth logs out and the script deletes the creds file; the next connect shows a fresh QR. **Pass**: FR-007.

### Scenario C — List groups (US4)
```bash
WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/list-groups.ts
```
**Expect**: every group with `id`, `name`, `addressingMode`. Copy your test group's `id` into `WA_GROUP_ID` for later scenarios. **Pass**: FR-019.

### Scenario D — Send & receive (US2)
```bash
# terminal 1 (leave running):
WA_GROUP_ID=<jid> WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/listen.ts
# terminal 2:
WA_GROUP_ID=<jid> WA_TEXT="hello from gateway" WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/send-message.ts
```
**Expect**: sent text appears in the group and a `MessageRef` prints. In terminal 1, a message you type **manually from your phone in that group is reported** (sender + text) — you are a participant on the linked account; a message in **another chat is NOT reported**. (The text from terminal 2 is also reported, as a live `notify` on the same account — expected under the participant model.) To confirm the gateway does not re-ingest its **own programmatic** output, run with `WA_DEBUG=1` and check such echoes are classified `append` (`skipping non-live item type=append`), not re-dispatched. **Pass**: FR-013, FR-014, FR-015, FR-016, FR-017 / SC-004.

### Scenario E — Poll & votes (US3) — the critical path
```bash
# terminal 1:
WA_GROUP_ID=<jid> WA_CREDS_FILE=./.wa-creds.json WA_POLL_KEYS_FILE=./.wa-poll-keys.json \
  npx tsx src/whatsapp-gateway/bin/watch-votes.ts
# terminal 2:
WA_GROUP_ID=<jid> WA_POLL_QUESTION="Available next game?" WA_POLL_OPTIONS="Yes,No,Maybe" \
  WA_CREDS_FILE=./.wa-creds.json WA_POLL_KEYS_FILE=./.wa-poll-keys.json \
  npx tsx src/whatsapp-gateway/bin/send-poll.ts
```
**Expect**: the poll appears in the group; `send-poll` prints a `MessageRef` and **writes the returned `PollKeyset`** to `WA_POLL_KEYS_FILE`. `watch-votes` reads that file to answer `resolvePollKeyset`, and as phones vote it prints each **per-voter selection** (voter + options) plus a running aggregate (computed in-script via `aggregateVotes`). **Change a vote** → that voter's selection is replaced (not double-counted). **LID-addressed** group → votes still attribute correctly; a person appearing as LID in votes and PN in chat counts **once**. A vote for a poll missing from the keys file is **skipped** (no crash).
**Pass**: FR-020, FR-021, FR-022, FR-023, FR-024, FR-025, FR-026 / SC-005.
**Note**: poll-vote decryption is implemented by the Gateway itself using the consumer-supplied keyset (auto-decryption was intentionally disabled in v7 — research.md §7). The cumulative tally lives in the consumer (here, the script), not the library.

### Scenario F — Delete (US5)
```bash
WA_GROUP_ID=<jid> WA_MESSAGE_ID=<id-from-send> WA_CREDS_FILE=./.wa-creds.json \
  npx tsx src/whatsapp-gateway/bin/delete-message.ts
```
**Expect**: a recently-sent message is revoked for everyone → `{ ok: true }`. Attempt an out-of-window/unknown id → `{ ok: false, reason }` printed clearly, **no crash**. **Pass**: FR-027, FR-028 / SC-006.

---

## Success-criteria coverage

| SC | Where validated |
|----|-----------------|
| SC-001 (consumer uses only Gateway surface) | Every `bin/*` imports only `../index.js` |
| SC-002 (QR once, then resume) | Scenario A |
| SC-003 (auto-reconnect vs terminal) | Scenario A + `disconnect-classifier`/`reconnect-policy` units |
| SC-004 (zero cross-chat leakage) | Scenario D + `group-filter` unit |
| SC-005 (accurate vote tally incl. LID) | Scenario E + `poll-tally`/`identity-resolver` units |
| SC-006 (best-effort delete) | Scenario F |
| SC-007 (fast boundary suite) | Part 1 |
| SC-008 (usable from docs alone) | This guide + contracts/ |

## Notes
- Keep `WA_CREDS_FILE` and `WA_POLL_KEYS_FILE` out of version control. Persistence is **consumer-side** (the entry-point scripts); the library itself writes nothing to disk.
- Do not run these against the production captain account; use a test number/group.
- Detailed implementation tasks come from `/speckit-tasks` (`tasks.md`), not this guide.
