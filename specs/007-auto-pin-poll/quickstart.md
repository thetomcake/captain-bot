# Quickstart: Auto-Pin the Availability Poll

**Feature**: 007-auto-pin-poll | **Date**: 2026-06-18

How to validate that the availability poll is pinned until game time, and that pinning/unpinning are
best-effort. Implementation lives in `tasks.md`; this is a run/validation guide.

## Prerequisites

- Repo installed (`npm install`); `@whiskeysockets/baileys@7.0.0-rc13` already present (pin support
  built in — no dependency change).
- For the manual path: a connected WhatsApp session and an authorized group (the standard
  `connect` / daemon setup from feature 002/003).

## Automated validation (primary)

Run the feature's tests:

```bash
npm test -- pin-duration                       # pure bucket selection
npm test -- poll-service                        # poll-pin integration (FakeGateway)
```

Expected (maps to the contracts):

1. **Bucket selection** (`tests/unit/whatsapp-gateway/pin-duration.test.ts`) — `selectPinDuration`
   returns `86400` for ≤24h, `604800` for ≤7d, `2592000` for ≤30d and for anything beyond 30d. See
   [contracts/gateway-pin.md](./contracts/gateway-pin.md).
2. **Poll pinned with the right window** — posting a poll for a fixture `N` days out calls
   `gateway.pinMessage(ref, secondsUntilGame)` with `secondsUntilGame = floor((gameDate − now)/1000)`,
   computed from the **injected clock** (deterministic). See
   [contracts/poll-pin-integration.md](./contracts/poll-pin-integration.md) P1/P7.
3. **Unpin-before-delete on replacement** — a forced replace unpins the old poll *before* deleting it,
   then pins the new poll; this holds even when the old poll's delete fails. P3/P4.
4. **Best-effort** — when `pinMessage` or `unpinMessage` reports `{ ok: false }`, the poll is still
   posted/replaced and votes still tracked; the failure is logged, never thrown. P2/P5.

The `FakeGateway` (`tests/helpers/fake-gateway.ts`) records `pinnedMessages`
(`{ ref, durationSeconds }`) and `unpinnedMessages`, and exposes failure toggles
(`pinOutcomeOverride` / `unpinOutcomeOverride`) to drive the best-effort cases — no Baileys import.

## Manual validation (real WhatsApp — optional)

1. Start the daemon (or run the `poll` CLI) against the authorized group with a confirmed next fixture
   whose game time is in the future.
2. Trigger a post (`!postpoll` in the group, or the `poll` CLI).
3. **Expect**: the poll appears **pinned** in the group. For a fixture within a week, WhatsApp shows a
   7-day pin; within a day, a 24-hour pin (the nearest covering bucket — see
   [research.md §2](./research.md)).
4. Force a replacement (`!postpoll` again). **Expect**: the previous poll is unpinned and removed, and
   the new poll is pinned.
5. Negative check: in a group/context where pinning is rejected, the poll still posts and votes still
   record — only a warning is logged.

## What is NOT changed

- No DB schema/migration; nothing new persisted (the pin is a transient WhatsApp side-effect).
- No new CLI command; behaviour rides the existing `!postpoll` / `poll` / `daemon` surfaces.
- No new dependency. `PollService` still depends only on the `IWhatsAppGateway` port (no Baileys).
