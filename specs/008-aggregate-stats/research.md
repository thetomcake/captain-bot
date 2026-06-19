# Phase 0 Research: Aggregated Statistics

All "NEEDS CLARIFICATION" in the technical context were resolved by the spec's `## Clarifications`
session (2026-06-19) and by reading the existing codebase (`schema.ts`, `stats.ts`,
`stat-service.ts`, `poll-service.ts`, `poll-presenter.ts`, `formatters.ts`, `season-service.ts`,
`cli/index.ts`, `end-of-season.ts`). There are no external dependencies to research. Findings below.

## 1. CLI surface — new command vs flags on `stats` (Q1)

**Decision**: **Extend the existing `stats` command** with four mutually-exclusive aggregate view
flags: `--summary` (team season summary, US1), `--players` (+ `--rank <metric>`, US2),
`--attendance` (US3), `--report` (single chat block, US4). The legacy `stats --game` / `stats
--season` raw per-game line views are unchanged when no aggregate flag is present. `--season <n>`
selects the season for the aggregate views (default current); `--json` on all.

**Rationale**: Clarification Q1 chose this explicitly — reuse the existing `stats` season-selector
and `--json` plumbing, keep the roll-ups discoverable alongside the raw views. The route already
exists (`case 'stats'` in `cli/index.ts`) and the command already resolves seasons via
`SeasonService`; adding view flags is the smallest cohesive change.

**Alternatives considered**:
- *A separate `summary` verb* (the pre-clarification design): rejected by Q1 — the user asked for
  these as options on the CLI reusing `stats`, not a second verb.
- *Three/four separate top-level commands*: rejected — more verbs than needed; flags on `stats` keep
  one entry point.

## 2. Where the aggregation logic lives (FR-013 reusability)

**Decision**: A pure module `src/stats/aggregations.ts` computes aggregates from a plain
`AggregationInput`; a thin `AggregateService` fetches rows and builds the input; the CLI only selects
a view and formats. A convenience `aggregateReport(input)` returns `{ season, players }` so the chat
report is one call.

**Rationale**: FR-013 requires the calculation be reusable by non-CLI surfaces without re-deriving
it. The codebase already demonstrates this split for stat capture (`stat-extractor.ts` pure →
`stat-service.ts` DB → `formatters.ts` CLI). The already-present `end-of-season` command is the
obvious future consumer of `aggregateReport` for an end-of-season WhatsApp message.

**Alternatives considered**:
- *All logic inside `AggregateService` (DB-coupled)*: rejected — couples arithmetic to Drizzle,
  untestable without a DB, unreusable by a message surface (violates FR-013).
- *SQL aggregate queries per metric*: rejected — the attended-games denominator and null-not-NaN
  rules are awkward and untestable against hand calculations in SQL; in-memory aggregation over a few
  hundred rows is trivial and fully unit-testable (SC-002).

## 3. The uniform "attended games" denominator (Q2 + denominator-unification clarification)

**Decision**: Every **per-player** rate divides by the player's **attended games** = completed games
the player answered "available/yes" to (`poll_responses.selectedOption === getPollOptions()[0]`). For
each attended game, the player's stat line is joined in if present; an attended game with no stat
record counts as a 0-goal/0-assist, non-`down`, non-tracked game (never excluded):

- goals/assists per attended game = `Σ goals(attended) / count(attended)`
- weight-loss % = `count(attended ∧ weightDirection = 'down') / count(attended)`
- food-tracking % = `count(attended ∧ foodTracking) / count(attended)`, where `foodTracking` is
  defaulted to `false` for a missing/null value (no stat record, or a null field) — the same default
  as `goals → 0`. Food tracking has no "unknown" state; missing simply means "not tracked".

**Rationale**: Q2 set the per-game denominator to attended games (attended-but-no-stat = a 0 game).
The later unification clarification extended that single denominator to the lifestyle rates,
explicitly superseding the earlier "÷ all reports" (Q5) and the FR-010 null-exclusion rule, and
matching the chat report's "of attended games" framing (FR-018). One denominator keeps every
per-player number comparable and the maths simple.

**Alternatives considered**:
- *Denominator = games with a stat record* (pre-clarification design): rejected by Q2 — a player
  present-by-poll with no stat line must count as a 0 game.
- *Exclude unknown weight / null food from the denominator* (FR-010 as originally written, Q5):
  rejected by the unification clarification — those now count against the player as non-`down` /
  non-tracked attended games.

## 4. Squad lifestyle rates = mean of per-player rates (Q5 as amended)

**Decision**: `squadWeightLossRate` and `squadFoodTrackingRate` (team summary + report "per week"
figures) are the **mean of the per-player rates over attended players** (players with ≥ 1 attended
game), each player weighted equally — not a pooled report count.

**Rationale**: Clarification Q5 chose mean-of-player-rates (each player weighted equally) so a
high-report-count player can't dominate the squad figure. "Attended players only" (FR-017) falls out
naturally — a player with zero attended games has a `null` rate and is excluded from the mean.

**Alternatives considered**: *Pooled across all reports* — rejected by Q5. *Include zero-attendance
players as 0%* — rejected; they have no attended games, so their rate is "not applicable", not 0.

## 5. Attendance denominator — eligible fixtures (Q3, FR-009/FR-015)

**Decision**: A player's attendance % = `count(Yes votes) / pollFixtureCount`, where
`pollFixtureCount` = **completed games in the season that have a poll**. Fixtures with no poll, and
non-completed fixtures, are excluded from the denominator. Average turnout per fixture = mean Yes
count over those same completed poll-bearing fixtures.

**Rationale**: Q3 defined eligible fixtures as completed games that had a poll; FR-015 excludes
poll-less fixtures so they don't skew turnout. Reading the affirmative option from
`getPollOptions()[0]` (= `"Yes"`) rather than hard-coding keeps attendance in lock-step if the poll
wording changes. `poll_responses` already stores one row per voter per poll keyed to a canonical
identity, and FR-009 says a stat record is explicitly NOT the attendance signal.

**Alternatives considered**:
- *All poll-bearing fixtures regardless of status*: rejected by Q3 — upcoming/cancelled polled
  fixtures would dilute attendance.
- *All completed games (poll-less count against the player)*: rejected by Q3/FR-015.
- *Stat-record presence as attendance*: rejected by FR-009.

## 6. Empty denominators → "not applicable", never NaN (FR-007/SC-004)

**Decision**: Every rate helper returns `number | null`; `null` renders as `n/a` (human) and `null`
(JSON). Division happens only when the denominator > 0.

**Rationale**: SC-004 forbids `NaN`/error/misleading values when a season or player has zero
qualifying (attended) games. `0/0 = NaN` in JS and a defaulted `0` reads as "attended and did
nothing". A nullable rate makes "no attended games" unambiguous in both output modes.

**Alternatives considered**: returning `0` (misleading), throwing (forbidden by SC-004),
`Infinity`/`NaN` (forbidden). All rejected.

## 7. Season-only scope; no all-time in v1 (Q4)

**Decision**: All aggregate views are season-scoped. There is no `--all-time` flag in v1.

**Rationale**: Q4 deferred all-time. The pure core takes a season's `AggregationInput`, so an
all-time scope is later just a different input builder — no rework (FR-013).

**Alternatives considered**: *Ship `--all-time` now* — rejected by Q4 (extra CLI selector + query
path + tests for no stated v1 need).

## 8. The shareable chat report — chat-safe formatting (FR-016/017/018, US4)

**Decision**: `stats --report` prints, in one invocation, a single contiguous block: a team section
(`Label: value` lines — avg attendance/game, total goals, total assists, avg goals/game, avg
assists/game, avg weight-loss % per week, avg food-tracking % per week, attended players only)
followed by one line per attended player (avg goals/attended game, avg assists/attended game,
food-tracking %, weight-loss %). **No fixed-width columns, box-drawing characters, ANSI colour, or
pager** — WhatsApp uses a proportional font, so aligned tables break on paste. `--report --json`
emits the same figures as `{ season, players }`. "Per week" labels the squad-level rate across
attended games (fixtures are ~weekly), i.e. the mean-of-player rates from §4.

**Rationale**: FR-016 requires a single paste-safe message; FR-017/FR-018 fix the content. The
report is a *presentation* of `aggregateSeason` + `aggregatePlayers` output, so it adds no new
computation — proving the FR-013 reuse seam.

**Alternatives considered**:
- *Reuse the `--players` aligned table for the report*: rejected — fixed-width columns misalign in a
  proportional chat font (violates FR-016).
- *A separate `report` command*: rejected — Q1 keeps everything on `stats`.

## 9. "No data" vs "not found" vs error, and exit codes (FR-011, Edge Cases)

**Decision**: Exit codes for the `stats` aggregate/report views:
- `0` — success, aggregates printed.
- `1` — **season not found**: the requested `--season <n>` does not exist for the team.
- `2` — **no data** (valid season, zero qualifying records: no completed games / no stats / no
  polls) **or** a usage error (unknown `--rank` metric, more than one aggregate view flag, an
  aggregate flag combined with `--game`); the stderr/JSON message disambiguates.
- `3` — unexpected error (caught exception — unchanged from the existing `stats` catch).

**Rationale**: FR-011 and the Edge Cases require the exit code to distinguish **empty from error** —
satisfied by `2` (no data) ≠ `3` (error) — and to report "no data" and "not found" with distinct
messages (`2` vs `1`). Reusing `2` for benign "couldn't produce output" cases (no-data and bad-usage)
matches the existing `stats` convention (missing selector → exit 2) while keeping the error path at
`3` as it already is in `stats.ts`. The legacy `--game`/`--season` raw views keep their current
behaviour.

**Alternatives considered**:
- *Empty as exit 0*: rejected — the Edge Case wants the exit code to mark empty distinctly from a
  populated success.
- *A 5th code for no-data vs bad-usage*: rejected as over-engineered — the message disambiguates and
  the only hard requirement is empty ≠ error.

## 10. Ranking metrics for leaderboards (FR-006)

**Decision**: `--rank <metric>` accepts `goals` (default), `assists`, `contributions`,
`attendance`, `weightloss`, `foodtracking`. Highest first. Players with a `null` value for the
metric sort last (stable). Unknown metric → exit 2.

**Rationale**: FR-006 mandates *at minimum* ranking by goals, highest first. The other metrics are
per-player aggregates already computed, so exposing them as sort keys is free. `null` rates sort last
so "no attended games" never tops a leaderboard.

**Alternatives considered**: goals-only (meets the minimum but wastes computed metrics); an
ascending option (no user need stated — out of scope).

## 11. The `!stats` in-chat trigger — model, throttle, dispatch (US5, FR-019–FR-022)

**Decision**: Add `src/whatsapp/stats-trigger.ts` modelled one-for-one on `postpoll-trigger.ts`:
`isStatsCommand(text)` (whole-message `!stats`, case-insensitive/trimmed, checked **before** stat
extraction), `STATS_MIN_INTERVAL_MS = 5 min`, and `createStatsHandler({ aggregateService, gateway,
groupId, minIntervalMs?, now? })`. On a trigger it resolves the **current** season, calls
`AggregateService.getReport`, and posts `formatReportBlock` via `gateway.sendMessage` (the posted
report is the success response); a no-data/not-found season posts the report's "no data" message; any
error is logged and swallowed. The 5-minute throttle state is held **in process memory** (closure
variable advanced via an injectable `now()`), not persisted.

**Rationale**:
- *Reuse, not re-derive (FR-013):* the report calc (`getReport`/`aggregateReport`) and the chat-safe
  formatter (`formatReportBlock`, §8) already exist for US4 and are paste-safe by construction
  (FR-016). US5 is pure presentation reuse — the seam FR-013 was built for.
- *In-memory throttle:* `!postpoll` throttles on `teams.lastPollPostedAt` because a poll is a
  persisted artifact whose post-time is already recorded; a `!stats` report is not stored, so adding a
  `lastReportPostedAt` column would be a schema migration purely for an anti-spam guard. The spec
  assumption explicitly allows non-durable throttle state, so an in-process timestamp is the smaller,
  schema-stable choice and preserves feature 008's "no schema change / no new write path" property. An
  injectable `now()` keeps it deterministically testable (the `!postpoll` test backdates the DB
  column; the in-memory analogue advances the clock).
- *p-queue dispatch (FR-020):* `gateway.sendMessage` already routes through the Gateway's `RateLimiter`
  (`sendLimiter.execute`, p-queue ≤5 msg/min). Posting the report through it means `!stats` is
  rate-limited by the **same** outbound queue as every other send including `!postpoll` — no new or
  bypassed dispatch path. The FR-021 cooldown and the gateway rate-limiter are distinct,
  complementary throttles.
- *Current season only:* the in-chat command takes no arguments (a whole-message match like
  `!postpoll`); historical seasons stay on the `stats --report --season <n>` CLI. `resolveSeason()`
  with no argument already yields the current season (or `not-found`), reused as-is.

**Alternatives considered**:
- *Persist `lastReportPostedAt` on `teams`* (exact `!postpoll` mechanism): rejected — a schema
  migration for a throttle that need not survive restart; breaks the no-schema-change property.
- *A new `!stats` dispatch/queue:* rejected — `gateway.sendMessage` already provides the required
  p-queue rate-limiting (FR-020); a second path would diverge from `!postpoll`.
- *Accept a season argument in chat (e.g. `!stats 2`):* rejected — over-scopes the trigger and breaks
  the whole-message match; the CLI already covers historical seasons.
- *Reply silently on success like `!postpoll`:* rejected — the user's deliverable is the report
  appearing in chat, so the posted report **is** the success response.
