# Implementation Plan: Aggregated Statistics

**Branch**: `008-aggregate-stats` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-aggregate-stats/spec.md`

## Summary

Add **derived, read-only season roll-ups** computed entirely from data already captured — `games`,
`stat_records`, and `poll_responses`. Per the clarifications (2026-06-19), the delivery surface is
the **existing `stats` command**, extended with four new view flags rather than a new command
(Q1): `--summary` (team season summary, US1), `--players` (per-player aggregates + leaderboards,
US2), `--attendance` (turnout, US3), and `--report` (a single paste-into-WhatsApp block, US4).
The legacy `stats --game` / `stats --season` raw per-game line views are left untouched. Scope is
**season-only** in v1 (all-time deferred, Q4). No schema change, no new write path, no new dependency.

A second surface — **US5, the in-chat `!stats` WhatsApp trigger** (added 2026-06-19; FR-019–FR-022) —
posts the `--report` block straight into the authorized group, modelled closely on the existing
`!postpoll` trigger. It is a thin presentation reuse of the same `aggregateReport` calc (FR-013) over
the **current** season, with a 5-minute anti-spam throttle and the Gateway's existing outbound
rate-limiter — **no** new computation, schema, dependency, or write path. See the
[`!stats` trigger amendment](#amendment-2026-06-19--stats-whatsapp-report-trigger-us5) below.

Two design decisions shape everything:

1. **The calculation is separated from both the database and the CLI** (FR-013). A pure module
   (`src/stats/aggregations.ts`) takes plain, already-fetched rows and returns aggregate objects —
   no Drizzle, no I/O, no formatting. A thin service (`src/services/aggregate-service.ts`) fetches
   the rows for a season and delegates. The CLI only selects a view and formats. This mirrors the
   existing `stat-extractor.ts` (pure) → `stat-service.ts` (DB) → `formatters.ts` (CLI) split, so the
   already-present `end-of-season` command (the spec's "future WhatsApp summary" surface) can later
   `import { aggregateReport } from '#src/stats/aggregations.js'` and reuse the chat report unchanged.

2. **One uniform "attended games" denominator** for every per-player rate (Q2 + the
   denominator-unification clarification). A player's *attended games* = completed games they
   answered "available/yes" to in the poll. Every per-player metric divides by that set:
   goals/assists per attended game, weight-loss % of attended games, food-tracking % of attended
   games. An attended game with no stat record is a 0-goal/0-assist, non-`down`, not-tracked game —
   counted in the denominator, never excluded. Missing/null `foodTracking` is read as `false` (not
   tracked), the **same default as `goals → 0`** (food has no "unknown" state, unlike weight
   direction). Squad lifestyle rates are the **mean of per-player rates** over attended players
   (FR-008/FR-010), not pooled counts.

**Technical approach**:

- **Pure core** — `src/stats/aggregations.ts` exposes `aggregateSeason(input)`,
  `aggregatePlayers(input, { rankBy })`, `aggregateAttendance(input)`, and a convenience
  `aggregateReport(input)` that returns `{ season, players }` for the chat report (FR-013 reuse
  seam). A shared `rate(num, den)` helper returns `number | null` (`null` = "not applicable", never
  `NaN` — FR-007/SC-004). All edge-case rules live here: attended-games denominators
  (FR-007/FR-008/FR-010), squad lifestyle = mean of per-player rates (FR-008), `Yes`-vote attendance
  over **completed** poll-bearing fixtures (FR-009/FR-015/Q3), games-by-status counts (FR-014), and
  one-row-per-canonical-identity de-dup (FR-005).
- **Service** — `src/services/aggregate-service.ts` (`AggregateService`) builds the
  `AggregationInput` for a season: it fetches the season's games (for status counts), the completed
  games' polls (for `pollFixtureCount`), the `Yes` voters per completed poll-bearing fixture, and the
  completed-game stat records, then assembles per-(completed game, player) **participation** rows
  (attendance ⟕ optional stat line). It resolves the season by number via `SeasonService` and
  distinguishes **not-found** from **no-data** (FR-011).
- **CLI** — extend `src/cli/commands/stats.ts` and the existing `case 'stats'` route in
  `src/cli/index.ts`. New view flags `--summary`, `--players` (+ `--rank <metric>`), `--attendance`,
  `--report` select an aggregate view; `--season <n>` (default current) chooses the season; `--json`
  everywhere. The flags are mutually exclusive with each other and with the raw `--game` view; the
  raw `--game`/`--season` behaviour is unchanged when no aggregate flag is present.
- **Formatting** — `src/cli/output/aggregate-formatters.ts` (new, alongside `formatters.ts`) with a
  table + JSON formatter per view. **The `--report` formatter is deliberately chat-first**: a single
  contiguous block of plain `Label: value` lines and one line per player — **no fixed-width columns,
  box characters, ANSI, or pager** (FR-016), because WhatsApp renders a proportional font that breaks
  aligned tables. The `--players` terminal view *may* use an aligned table; the report may not. The
  affirmative availability option is read from `getPollOptions()[0]` (= `Yes`) so attendance stays in
  lock-step with the poll surface.

No schema migration, no new captured data, no Gateway interaction (the attendance signal is read from
already-persisted `poll_responses`).

## Technical Context

**Language/Version**: TypeScript on Node.js ≥ 22, ESM (`"type": "module"`, NodeNext)

**Primary Dependencies**: drizzle-orm + better-sqlite3 (existing). **No new dependencies.** Reuses
`SeasonService`, the `games`/`stat_records`/`poll_responses`/`polls` schema, and
`getPollOptions()` (`src/whatsapp/poll-presenter.ts`).

**Storage**: SQLite via Drizzle. **No schema change** — aggregates are derived on demand from
existing tables; nothing is persisted.

**Testing**: Vitest. The pure `aggregations.ts` is unit-tested directly with hand-calculated
fixtures (SC-002) — the bulk of coverage lives here since the requirements are arithmetic, and the
attended-games denominator rules need exhaustive edge cases (attended-no-stat, stat-no-attendance,
unknown weight, null food, zero attended games → `null`). The service + extended CLI command are
integration-tested against a real in-memory DB (`createTestDatabase` /
`setTestEnvironment(createTestConfig({ databasePath: ':memory:' }))`), mirroring
`tests/integration/stats/stats-command.test.ts`. One human + one JSON assertion per view (minimal
output validation per constitution II), plus one assertion that the `--report` output is a single
block with no tab/box/ANSI characters (FR-016). No new service-boundary mock (no Gateway, no network).

**Target Platform**: Linux/macOS CLI (single-operator).

**Project Type**: Single project (CLI tool) — Option 1 structure below.

**Performance Goals**: Interactive CLI; a season is tens of games and tens of players. All work is a
handful of indexed SELECTs (`idx_game_status`, `idx_stat_user`, `idx_response_poll`, `idx_poll_game`)
plus in-memory aggregation. No target beyond "feels instant" (< ~100 ms typical).

**Constraints**: Read-only / derived (no new write path). Never emit `NaN`/error/misleading zero for
empty denominators (SC-004). Single operator team (`teamId = 1`). The `--report` human output MUST be
paste-safe for WhatsApp (FR-016).

**Scale/Scope**: One team, a season ≈ ≤ ~30 games and ≤ ~30 players.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. CLI-First** ✅ — delivered as new flags on the existing `stats` CLI command; stdout for data,
  stderr for human errors, both human-readable and `--json` output (FR-012, reusing the `stats`
  conventions per Q1).
- **II. Test-First (NON-NEGOTIABLE)** ✅ — tests precede implementation. Pure aggregation unit tests
  (FR/SC-tagged, hand-calculated per SC-002) and service/CLI integration tests are written and seen
  to fail first. Output validation kept minimal (one human + one JSON per view, plus the paste-safe
  assertion for `--report`); no library/format internals tested. Follows `tests/README.md` (real
  `:memory:` DB, no over-mocking).
- **III. TypeScript** ✅ — strict TS, NodeNext, `.js` import extensions, `#src/*` subpath imports.
  No `../../../`.
- **IV. Security-First (NON-NEGOTIABLE)** ✅ — read-only derivation from existing rows; no new
  inputs, no credentials, no new write paths, no injection surface (parameterised Drizzle queries
  only). Season selector is validated (not-found handled, FR-011).

**Result: PASS** — no violations, Complexity Tracking not required.

### Post-Design Re-check

After Phase 1 design (below), the check still **PASSES**: no new dependency, no schema change, the
pure/service/CLI split keeps each layer single-responsibility, and there is no new persisted state.
Extending `stats` (rather than adding a verb) keeps the surface small and is the clarified choice.
Complexity Tracking remains empty.

## Project Structure

### Documentation (this feature)

```text
specs/008-aggregate-stats/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (derived aggregate shapes + computation rules)
├── quickstart.md        # Phase 1 output (runnable validation scenarios)
├── contracts/
│   ├── cli-stats-aggregates.md  # The new `stats` aggregate/report flags (flags, exit codes, output)
│   ├── aggregations.md          # The pure aggregation core's input/output contract (FR-013)
│   └── whatsapp-stats-trigger.md # US5 — the `!stats` in-chat trigger (FR-019–FR-022)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── stats/
│   ├── stat-extractor.ts        # (existing) pure parser
│   └── aggregations.ts          # NEW — pure season/player/attendance/report core (FR-013)
├── services/
│   ├── season-service.ts        # (existing) season resolution / history
│   ├── stat-service.ts          # (existing) stat capture + raw read queries
│   ├── poll-service.ts          # (existing) poll responses read model
│   └── aggregate-service.ts     # NEW — fetch season rows, build participation, delegate
├── cli/
│   ├── commands/
│   │   ├── stats.ts            # MODIFIED — add --summary/--players/--attendance/--report views
│   │   └── daemon.ts           # MODIFIED (US5) — wire AggregateService + `!stats` handler into the router
│   ├── output/
│   │   ├── formatters.ts       # (existing) raw stats/fixtures/seasons formatters
│   │   └── aggregate-formatters.ts  # NEW — table + JSON per view; chat-safe report formatter (reused by US5)
│   └── index.ts                # MODIFIED — extend the `stats` route + help text with new flags
└── whatsapp/
    ├── event-router.ts         # MODIFIED (US5) — gate `!stats` before stat extraction, beside `!postpoll`
    ├── postpoll-trigger.ts     # (existing) the trigger US5 is modelled on
    └── stats-trigger.ts        # NEW (US5) — isStatsCommand + createStatsHandler (throttle, post report)

tests/
├── unit/stats/
│   └── aggregations.test.ts     # NEW — pure aggregation maths (SC-002 hand calcs, attended-games edge cases)
└── integration/
    ├── stats/
    │   └── stats-aggregates.test.ts # NEW — extended stats CLI: summary/players/attendance/report, no-data, not-found, json, rank
    └── whatsapp/
        └── stats-trigger.test.ts    # NEW (US5) — `!stats`: posts report, throttle window, no-data, ignores ordinary chat
```

**Structure Decision**: Single-project CLI layout (Option 1). The feature slots into the established
`stats/` (pure) → `services/` (DB) → `cli/` (presentation) layering already used by the stat-capture
view; extending the `stats` command (Q1) means modifying `stats.ts` + the `index.ts` route rather
than adding a new command file. No new top-level directory.

## Complexity Tracking

> No Constitution Check violations — this section intentionally left empty.

## Amendment 2026-06-19 — `!stats` WhatsApp report trigger (US5)

This amendment adds the in-chat surface for the report (US5, FR-019–FR-022). It is deliberately a
**thin trigger over the work already planned above** — it reuses `AggregateService.getReport`
(FR-013) and the chat-safe `formatReportBlock` (FR-016) verbatim and adds **no** aggregation,
schema, dependency, or write path. It is modelled one-for-one on the existing `!postpoll` trigger
(`src/whatsapp/postpoll-trigger.ts`).

### Design

A new pure-ish trigger module `src/whatsapp/stats-trigger.ts`, mirroring `postpoll-trigger.ts`:

- `isStatsCommand(text)` — true iff the whole trimmed, lower-cased message equals `!stats` (FR-019).
  A message that merely contains "stats" is ordinary chat. The event-router calls it **before** stat
  extraction so the command is never captured as a stat.
- `STATS_MIN_INTERVAL_MS = 5 * 60 * 1000` — the anti-spam window (FR-021), exported like
  `POSTPOLL_MIN_INTERVAL_MS`.
- `createStatsHandler(deps)` → `(message) => Promise<void>`. Deps:
  `{ aggregateService: AggregateService, gateway: IWhatsAppGateway, groupId: string, minIntervalMs?, now? }`.

Handler flow (mirrors `handlePostPoll`):

1. **Throttle (FR-021)** — if a report was posted within `minIntervalMs`, log and return (silent
   in-chat). Unlike `!postpoll`, which reads `teams.lastPollPostedAt` (a column that exists because a
   poll *is* a persisted artifact), a `!stats` report is **not** stored, so the last-posted time is
   held **in process memory** in the handler closure (a `lastPostedAt: number | null`, advanced via
   the injectable `now()`/`Date.now`). This keeps feature 008's "no schema change / no new write
   path" property intact; per the spec assumption the window need not survive a daemon restart (it is
   purely an anti-spam guard). Tests inject `now` to cross the window deterministically (the
   `!postpoll` test backdates the DB column — the in-memory equivalent is a controllable clock).
2. **Resolve the current season** — `aggregateService.resolveSeason()` (no arg ⇒ current). A
   `not-found` result (no current season at all) is treated as **no data**.
3. **Compute the report** — `aggregateService.getReport(season.id)`. If `season.hasData` is false (or
   the season was not-found), post the report's **"no data"** message rather than an empty block
   (FR-020, consistent with the CLI `--report` no-data path and FR-011).
4. **Post** — otherwise `gateway.sendMessage(groupId, formatReportBlock({ season, players }))`. The
   posted block **is** the success response (unlike `!postpoll`, which is silent on success).
5. **Advance the throttle** — set `lastPostedAt = now()` after **any** posted message (report *or*
   no-data) so repeats are suppressed for 5 minutes either way.
6. **Errors (FR-022)** — wrap the compute/post in try/catch: log and return, never throw (the router
   also has an outer catch). No partial/malformed report is posted. Every outcome
   (`posted` / `no-data` / `throttled` / `failure`) is logged.

**p-queue / outbound throttle (FR-020):** the report is sent through `gateway.sendMessage`, which
already wraps every send in the Gateway's `RateLimiter` (`sendLimiter.execute(...)`, p-queue,
`intervalCap=1` over `minMessageDelayMs`, ≤5 msg/min). So `!stats` is dispatched and rate-limited by
the **same** outbound queue as `!postpoll`'s poll send and reply — the trigger does **not** introduce
or bypass any dispatch path. The FR-021 5-minute cooldown and this gateway rate-limiter are two
distinct, complementary throttles.

### Wiring

- `src/whatsapp/event-router.ts` — add a `handleStats` dep and gate `isStatsCommand(message.text)`
  **first**, beside the existing `isPostPollCommand` check, returning before stat capture (FR-019).
  Both command checks precede `statService.captureFromMessage`.
- `src/cli/commands/daemon.ts` — construct `new AggregateService(db)` and
  `createStatsHandler({ aggregateService, gateway, groupId })`, and pass `handleStats` to
  `registerEventRouter`. No other daemon change (no scraper, no cron — `!stats` is a pure DB read).

### Constitution re-check (US5)

Still **PASSES**. **I. CLI-First** — the daemon is the CLI surface; `!stats` adds no new verb, only an
in-chat trigger that reuses the report. **II. Test-First** — `isStatsCommand` matching and the handler
(post / throttle / no-data / error / ignore-ordinary-chat) are integration-tested over `FakeGateway`
with a real `:memory:` DB and `AggregateService`, written to fail first; output validation stays
minimal (the chat-safe formatting is already asserted by the US4 report tests, not re-tested here).
**III. TypeScript** — `#src/*` imports, `.js` extensions, strict. **IV. Security-First** — read-only
derivation, no new inputs/credentials/write paths; any group member may trigger (FR-019), matching the
accepted `!postpoll` trade-off (a report is read-only, so the footgun is even smaller — no votes are
destroyed). Complexity Tracking remains empty.

### Test plan (US5)

`tests/integration/whatsapp/stats-trigger.test.ts`, mirroring `postpoll-trigger.test.ts`:

- `isStatsCommand` — matches `!stats` / `  !Stats  ` / `!STATS`; rejects `stats`, `!stats now`,
  `let's check stats`, `null`, `''`.
- Handler over `FakeGateway` + a real `:memory:` DB seeded with a current season of games / stats /
  poll responses + `AggregateService`:
  - (a) `!stats` with seeded data → one `sentMessages` entry to `groupId` whose text matches
    `formatReportBlock(getReport(...))` (the success response is the posted report).
  - (b) current season with no qualifying data → one `sentMessages` entry carrying the "no data"
    message (not an empty block).
  - (c) ordinary chat (`"how were the stats"`) → nothing sent.
  - (d) throttle: a second `!stats` within the window (real `STATS_MIN_INTERVAL_MS`) → still one
    `sentMessages` entry (second ignored, silent); after advancing the injected `now` past the
    window → a second report is posted.
  - (e) compute/post failure (inject a failing gateway/service) → logged, nothing partial sent, no
    throw.
