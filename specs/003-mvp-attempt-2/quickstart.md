# Quickstart & Validation: MVP (Gateway-native)

**Feature**: `003-mvp-attempt-2` | **Date**: 2026-06-15

How to run the MVP and validate each user story against its acceptance scenarios. Per the spec,
**no existing code is trusted** — every story must be re-verified here on the Gateway-clean
codebase. See [contracts/cli-commands.md](./contracts/cli-commands.md),
[contracts/gateway-port.md](./contracts/gateway-port.md), and [data-model.md](./data-model.md).

## Prerequisites

- Node.js 22.x; `npm install`; `npm run build` (or `npm run dev` for `tsx` watch).
- `.env` with at least `TEAM_NAME`, `CLUB_URL` (a `manvfatfootball.com/club/...` URL). Add
  `AUTHORIZED_GROUP_ID=<id>@g.us` after the `connect` step. Optional: `DATABASE_PATH`, `TIMEZONE`
  (default `Europe/London`).
- A phone with WhatsApp for the one-time QR scan (interactive — not part of the automated suite).

## Automated test suite (the primary gate)

```bash
npm test            # full Vitest suite — target < 10 s (SC-010)
npm run test:unit
npm run test:integration
```

Suite must include and pass:
- **SC-011 guard** (`tests/integration/whatsapp/no-baileys-import.test.ts`): asserts no file under
  `src/` except `src/whatsapp-gateway/**` imports `@whiskeysockets/baileys`.
- **US1** fixture retrieval + ordering (fake scraper, static HTML fixture).
- **US2** poll posting + vote capture/tally via `FakeGateway` (canonical identity, withdrawal,
  no double-count).
- **US3** stat extraction (pure) + capture window/merge/defaults (fake Gateway `simulateMessage`).
- **US4** view stats (view-only); persistence across seasons.
- **US5** season transition (all prior fixtures disappear → new season, old preserved).
- **US6** poll-response view (`fixtures --show-responses`): per-fixture grouping, canonical-id
  fallback, "no poll"/"no responses" rendering, `--json` shape, plain `fixtures` output unchanged
  (real in-memory DB + services, no Gateway).

## Manual / interactive validation

WhatsApp pairing and live votes use the Gateway's own `bin/` entry points (see
`src/whatsapp-gateway/README.md`) and the MVP `connect`/`daemon` commands; they are excluded from
the automated suite by design.

### Setup (one time)
```bash
captain-stats init --team-name "My Team" --club-url https://manvfatfootball.com/club/watford/
captain-stats connect          # scan terminal QR or open the saved PNG; note the group id
# set AUTHORIZED_GROUP_ID=<id>@g.us in .env
captain-stats daemon -f        # resumes the same session — no second QR scan
```

## Per-story acceptance validation

### US1 — View fixtures (review + migrate)
```bash
captain-stats fixtures            # all upcoming, chronological, with date/time/opponent/venue
captain-stats sync                # re-scrape; updated fixtures reflected
```
✅ Scenarios 1–3: fields present, chronological order, updates reflected (SC-001 < 5 s).

### US2 — Post polls + capture votes (rework; manual `!postpoll` trigger)
- With the daemon running, send `!postpoll` in the authorized group → confirm the daemon re-fetches
  fixtures and posts a poll for the **next** fixture (silent on success), within ~30 s (SC-002).
- `captain-stats poll --dry-run` previews; the `poll` CLI is the admin equivalent of `!postpoll`.
- Cast/change/withdraw votes in WhatsApp; confirm each is recorded against the voter's canonical
  identity and the tally reflects changes/withdrawals with no double-counting (SC-008).
- Send `!postpoll` **again** (or `captain-stats poll --force`) → confirm the old poll + its votes
  are hard-deleted and a fresh poll is posted, old message best-effort deleted (FR-027). This is
  also how a **rescheduled** fixture is handled — re-trigger after the change (FR-026).
- Send `!postpoll` when the next fixture is an unconfirmed "Fixtures to be confirmed" placeholder
  (or with the club site unreachable) → confirm **no** poll is posted and the bot replies in-chat
  explaining why (FR-028).

### US3 — Capture stats from chat (rebuild)
Within 3 days of a game, send messages and verify capture:
- `"2 goals, 1 assist, weight down, tracked food"` → goals=2, assists=1, weight=down, tracking=yes.
- `"scored today"` → 1 goal. · `"great game everyone"` → nothing captured (< 70%).
- 4+ days after the game → treated as chat, not captured.
- First partial message applies defaults (goals=0/assists=0/weight=unknown/tracking=no); later
  partial messages merge only the mentioned fields. A correction overrides only the named field —
  after `"2 goals, 2 assists"`, a later `"correction 1 goal"` → goals=1, assists stay 2.

### US4 — View stats (rebuild, view-only)
No captain-side stat correction (FR-024); `stats` is view-only. Stored stats change only via a
later player-message field-level override (FR-019) — e.g. a follow-up "correction 1 goal".
```bash
captain-stats stats --game <id>                 # grouped by player
captain-stats seasons                           # pick a previous season
captain-stats stats --season <n>                # historical stats viewable
```

### US5 — Season transition (implement + review)
- Simulate the club site dropping all current fixtures and showing new ones (via `sync` against an
  updated fixture source); confirm a **new season** is created, the old season is preserved and
  still viewable via `seasons`/`stats --season`, with no cross-season contamination (SC-006/SC-007).

### US6 — View poll responses (`fixtures --show-responses`, view-only)
After at least one poll has gathered votes (US2), confirm availability is readable from the CLI.
```bash
captain-stats fixtures --show-responses             # current season, responses under each fixture
captain-stats fixtures --all --show-responses       # include completed fixtures
captain-stats fixtures --season <n> --show-responses # a previous season
captain-stats fixtures --show-responses --json      # machine-readable (poll: null | {question, responses})
```
Expect each voter's name (canonical id when no name) and choice grouped under the fixture; a
fixture with no poll shows `(no poll posted)`, a poll with no votes shows `(no responses yet)`,
and plain `captain-stats fixtures` is unchanged (FR-030, SC-012).

## Done-when
- All automated tests green in < 10 s; SC-011 guard passes.
- Each story's scenarios verified above on the Gateway-clean build.
- No MVP source imports Baileys; all WhatsApp behaviour flows through `IWhatsAppGateway`.
