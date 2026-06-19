---
description: "Task list for feature 008 — Aggregated Statistics"
---

# Tasks: Aggregated Statistics

**Input**: Design documents from `/specs/008-aggregate-stats/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Test tasks ARE included — Constitution II (Test-First, NON-NEGOTIABLE) requires tests
written and seen to fail before implementation. The pure-core unit tests carry the bulk of
correctness (SC-002 hand calculations) and are where the **definition changes** are pinned; the
service/CLI integration tests follow `tests/README.md` (real `:memory:` DB, no over-mocking).

**Organization**: Tasks are grouped by user story. Per clarification Q1 the views are **new flags on
the existing `stats` command** (not a new verb). US1 (`--summary`) is the shippable MVP; US2
(`--players`), US4 (`--report`), and US3 (`--attendance`) are additive flags on the same command.

**Definition changes to keep front-of-mind (2026-06-19 clarifications):**

- **Attended-games denominator everywhere.** A player's *attended games* = completed games they
  voted "Yes" to. Every per-player rate divides by that set. An attended game with no stat record is
  a 0-goal/0-assist, non-`down`, non-tracked game (counted, never excluded). (Q2 + unification)
- **Squad lifestyle rates = mean of per-player rates** over attended players (not pooled). (FR-008/Q5-amended)
- **Attendance denominator = completed poll-bearing fixtures only.** (Q3/FR-015)
- **Season-only**, no all-time. (Q4)
- **New `--report`**: one paste-into-WhatsApp block, plain lines, **no columns/box/ANSI**. (FR-016/017/018)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 / US4 (Setup, Foundational, Polish carry no story label)
- Exact file paths are included in every task

## Path Conventions

Single-project CLI layout (plan.md §Project Structure): sources in `src/`, tests in `tests/`,
`#src/*` subpath imports, `.js` import extensions (Constitution III).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Place the feature on its own branch. No new dependencies, no schema change, no scaffolding (existing TS/Vitest/Drizzle project).

- [X] T001 ~~Create and switch to feature branch `008-aggregate-stats` from `master`~~. **Skipped by direction (2026-06-19):** the `specs/008-aggregate-stats/` design docs are now committed and tracked on `master` (commit c8c9815), so all implementation work proceeds directly on `master` rather than a feature branch. No new dependencies, no schema change, no scaffolding required.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared pure types + `rate` helper, and the service's season→`AggregationInput` builder (the **`Participation`** join that encodes the attended-games definition). EVERY view depends on these.

**⚠️ CRITICAL**: No user-story view can be implemented until this phase is complete.

- [X] T002 [P] Define the pure aggregation types and shared rate helper in `src/stats/aggregations.ts`: `AggregationInput`, `GameStatus`, `Participation`, output shapes `SeasonAggregate` / `PlayerAggregate` / `AttendanceReport`, `RankMetric`, and `rate(numerator, denominator): number | null` (returns `null` when `denominator === 0`, never `NaN`). Shapes exactly per [data-model.md](./data-model.md) — note `Participation` carries `attended`, `goals` (default 0), `assists` (default 0), `weightDirection` (`…|null`), `foodTracking` (**plain `boolean`, default `false`** — null/missing food is read as not-tracked, same default as `goals = 0`), `hasStatRecord`. (FR-007, FR-010, SC-004, FR-013)
- [X] T003 [P] Write failing unit tests for `rate()` in `tests/unit/stats/aggregations.test.ts` (denominator 0 → `null`; positive denominator → exact quotient; never `NaN`/`Infinity`). (SC-004)
- [X] T004 Implement the `AggregateService` scaffold + season→input builder in `src/services/aggregate-service.ts`: constructor `(db)`; `resolveSeason(seasonNumber?)` resolving via `SeasonService` (default current) and signalling **not-found** distinctly; `getSeasonData(seasonId): AggregationInput` that (a) loads all `games` for the season for `gamesByStatus`, (b) computes `pollFixtureCount` = **completed** games that have a `polls` row (Q3/FR-015), (c) builds one `Participation` row per (completed game, player) by LEFT-joining the completed games' `Yes` voters (`poll_responses.selectedOption === getPollOptions()[0]`, via `polls`) with `stat_records`, keyed on `whatsappUsers.canonicalId` — `attended` from the vote; when no stat record, `goals`/`assists` default to `0`, `weightDirection` to `null`, and **`foodTracking` to `false`** (a null `foodTracking` on an existing row is likewise coerced to `false` — same default as `goals = 0`, FR-010). Depends on T002. (FR-002, FR-005, FR-007, FR-009, FR-010, FR-015)
- [X] T005 [P] Write a failing integration test for `getSeasonData` in `tests/integration/stats/stats-aggregates.test.ts` (seed via `setTestEnvironment(createTestConfig({ databasePath: ':memory:' }))` + `migrate`): asserts the **definition changes** at the service boundary — an attended game with no stat record yields a `Participation` row with `attended: true, hasStatRecord: false, goals: 0, foodTracking: false` (food defaults to NO, same as goals→0); a stat record with a null `foodTracking` is coerced to `false`; a stat record on a non-attended completed game yields `attended: false`; `pollFixtureCount` counts only completed poll-bearing fixtures; players resolve once per canonical id. (FR-005, FR-007, FR-009, FR-015, Q2, Q3)

**Checkpoint**: Pure types + `rate` exist; the service turns a season into a correct attended-games `AggregationInput`. View implementation can begin.

---

## Phase 3: User Story 1 — Season team summary (Priority: P1) 🎯 MVP

**Goal**: `stats --summary` prints a season-wide team summary — total goals/assists, games-by-status, goals/assists per completed game, squad size, average turnout, and squad lifestyle rates (mean of per-player rates) — in human and JSON form, for any season.

**Independent Test**: Seed a season with completed games + stat records + Yes votes; run `stats --summary --season <n>` and `--json`; confirm figures match a hand calculation; a non-current season works; an empty season → "no data" (exit 2); a missing season → "not found" (exit 1).

### Tests for User Story 1 (write FIRST, must FAIL)

- [X] T006 [P] [US1] Write failing unit tests for `aggregateSeason` in `tests/unit/stats/aggregations.test.ts`: totals over completed-game stat records; `gamesByStatus` counts; `goalsPerGame`/`assistsPerGame` `null` when no completed games; **`squadWeightLossRate`/`squadFoodTrackingRate` = MEAN of per-player attended-games rates over attended players** (not pooled), `null` when no attended players; `averageTurnoutPerFixture` over completed poll-bearing fixtures only; `squadSize` distinct by canonical id; `hasData=false` on empty scope. (FR-001, FR-008, FR-010, FR-014, FR-015, Q5-amended, SC-002, SC-004)
- [X] T007 [P] [US1] Write failing integration tests for `stats --summary` in `tests/integration/stats/stats-aggregates.test.ts`: season with data prints totals/status/rates; past (non-current) season works (FR-003); empty season → exit 2 ("no data"); missing season → exit 1 ("not found"); `--json` emits the same figures; **the legacy `stats --season <n>` raw view is unchanged** when no aggregate flag is present. (FR-001, FR-011, FR-012, SC-001, SC-003, SC-005)

### Implementation for User Story 1

- [X] T008 [US1] Implement `aggregateSeason(input): SeasonAggregate` in `src/stats/aggregations.ts` per [contracts/aggregations.md](./contracts/aggregations.md) (A1–A3, A9–A11, A14) — compute per-player rates internally (shared with US2) to derive the **mean** squad lifestyle rates and `averageTurnoutPerFixture`. Makes T006 pass. Depends on T002.
- [X] T009 [US1] Implement `AggregateService.getSeasonSummary(seasonId)` in `src/services/aggregate-service.ts` (build input via `getSeasonData`, call `aggregateSeason`, surface `hasData=false` as the no-data signal). Depends on T004, T008.
- [X] T010 [P] [US1] Implement `formatSeasonSummaryTable` and `formatSeasonSummaryJSON` in `src/cli/output/aggregate-formatters.ts` (new file; `null` rates render `n/a` in human output, `null` in JSON). Depends on T002.
- [X] T011 [US1] Extend `src/cli/commands/stats.ts`: add an aggregate-view dispatcher to the existing `statsCommand` (new options `summary`/`players`/`attendance`/`report`/`rank`), enforce **mutual exclusivity** (more than one aggregate flag, or an aggregate flag with `--game`, → usage error exit 2), resolve the season (default current), dispatch the `--summary` view, and apply exit codes `0` success / `1` not-found / `2` no-data-or-usage / `3` unexpected (reuse the existing `emit()` `{ error }` JSON envelope). Leave the legacy `--game`/`--season` raw path untouched. Depends on T009, T010. (FR-011, FR-012)
- [X] T012 [US1] Extend the `case 'stats'` route in `src/cli/index.ts`: register `summary` in minimist `boolean`, parse `--summary` into `StatsOptions`, and add the `--summary` / `--season` lines to the `stats` help text. Depends on T011.

**Checkpoint**: `stats --summary [--season <n>] [--json]` fully works — MVP shippable.

---

## Phase 4: User Story 2 — Per-player aggregates & leaderboards (Priority: P2)

**Goal**: `stats --players` lists each player once (canonical identity) with totals, contributions, **per-attended-game** rates, attendance %, weight-loss % and food-tracking % (all over attended games), ordered by a chosen metric (default goals), highest first.

**Independent Test**: Seed a season with multiple players and varying stats/votes; `stats --players` shows one row per player with correct attended-games figures; `--rank <metric>` reorders highest-first; a zero-attended-game player shows `n/a`; an attended-no-stat game counts as a 0 game; a player under multiple address forms is counted once.

### Tests for User Story 2 (write FIRST, must FAIL)

- [X] T013 [P] [US2] Write failing unit tests for `aggregatePlayers` in `tests/unit/stats/aggregations.test.ts` pinning the **definition changes**: `attendedGames` = count of attended participation rows; `goalsPerGame`/`assistsPerGame` = totals over attended games / `attendedGames`, with an attended-no-stat game contributing 0 (A5); `weightLossRate` = `count(attended ∧ down)/attendedGames` with `up`/`same`/`unknown`/missing counted in the denominator, no exclusions (A6); `foodTrackingRate` = `count(attended ∧ foodTracking)/attendedGames` with missing/null food read as `false` (not-tracked) — same default as `goals = 0` — so every attended game counts (A7); `attendanceRate` = Yes-count / `pollFixtureCount` (A8); rates `null` when `attendedGames === 0`; canonical de-dup (A12, SC-006); `rankBy` ordering highest-first with `null` last (A13, FR-006). (FR-004, FR-005, FR-006, FR-007, FR-008, FR-010, SC-002, SC-006)
- [X] T014 [P] [US2] Write failing integration tests for `stats --players` in `tests/integration/stats/stats-aggregates.test.ts`: one row per player; `--rank goals` and a second metric reorder correctly; unknown `--rank` value → exit 2; a zero-attended player renders `n/a`; `--json` shape `{ season, rankBy, players: [...] }`. (FR-004, FR-006, FR-012)

### Implementation for User Story 2

- [X] T015 [US2] Implement `aggregatePlayers(input, { rankBy='goals' }): PlayerAggregate[]` in `src/stats/aggregations.ts` (attended-games denominators per A4–A8; highest-first ordering, `null` last per A13). Makes T013 pass. Depends on T002 (and factor out the shared per-player computation used by T008). 
- [X] T016 [US2] Implement `AggregateService.getPlayerAggregates(seasonId, rankBy)` in `src/services/aggregate-service.ts` (build input via `getSeasonData`, call `aggregatePlayers`). Depends on T004, T015.
- [X] T017 [P] [US2] Implement `formatPlayerAggregatesTable` and `formatPlayerAggregatesJSON` in `src/cli/output/aggregate-formatters.ts` (`n/a`/`null` for null rates; columns per [contracts/cli-stats-aggregates.md](./contracts/cli-stats-aggregates.md) — this terminal view MAY use an aligned table). Depends on T002.
- [X] T018 [US2] Wire the `--players` view into `src/cli/commands/stats.ts`: validate `--rank <metric>` against the `RankMetric` set (unknown → exit 2), call `getPlayerAggregates`, format. Depends on T011, T016, T017.
- [X] T019 [US2] Extend the `stats` route in `src/cli/index.ts`: register `players` in minimist `boolean` and `rank` in `string`; parse `--players` / `--rank`; add their help lines. Depends on T012, T018.

**Checkpoint**: US1 and US2 both work; leaderboards available.

---

## Phase 5: User Story 4 — Shareable chat report (Priority: P2)

**Goal**: `stats --report` prints, in one invocation, a single paste-into-WhatsApp block: a team section (avg attendance/game, total goals/assists, avg goals/assists per game, avg weight-loss %/week, avg food-tracking %/week — attended players only) followed by one line per attended player (avg goals/assists per attended game, food-tracking %, weight-loss %). Composes the US1+US2 aggregates (FR-013), so it follows them.

**Independent Test**: Seed a full season; run `stats --report --season <n>`; confirm a single contiguous block whose team + per-player figures match a hand calculation and which contains **no tab, box-drawing, or ANSI characters** (paste-safe); `--json` emits `{ season, players }`; an empty season → "no data".

### Tests for User Story 4 (write FIRST, must FAIL)

- [X] T020 [P] [US4] Write a failing unit test for `aggregateReport(input)` in `tests/unit/stats/aggregations.test.ts`: returns exactly `{ season: aggregateSeason(input), players: aggregatePlayers(input) }` (default rank) with no recomputation/divergence (A15, FR-013). (SC-002)
- [X] T021 [P] [US4] Write failing integration tests for `stats --report` in `tests/integration/stats/stats-aggregates.test.ts`: single block contains the team section and one line per attended player matching seeded data; the human output contains **no `\t`, box-drawing, or ANSI escape characters** (FR-016 paste-safety); `--report --json` emits `{ season, players }`; empty season → exit 2 ("no data"). (FR-016, FR-017, FR-018, SC-007)

### Implementation for User Story 4

- [X] T022 [US4] Implement the `aggregateReport(input): { season, players }` convenience in `src/stats/aggregations.ts`. Makes T020 pass. Depends on T008, T015.
- [X] T023 [US4] Implement `AggregateService.getReport(seasonId)` in `src/services/aggregate-service.ts` (build input via `getSeasonData`, call `aggregateReport`; `hasData` from the season aggregate). Depends on T004, T022.
- [X] T024 [P] [US4] Implement `formatReportBlock` (chat-safe: plain `Label: value` lines for the team section + one `- Name — …` line per attended player; **no fixed-width columns, no box-drawing, no ANSI, no pager** — FR-016) and `formatReportJSON` in `src/cli/output/aggregate-formatters.ts`. Depends on T002.
- [X] T025 [US4] Wire the `--report` view into `src/cli/commands/stats.ts` (dispatch to `getReport` + `formatReportBlock`/`formatReportJSON`). Depends on T011, T023, T024.
- [X] T026 [US4] Extend the `stats` route in `src/cli/index.ts`: register `report` in minimist `boolean`; parse `--report`; add its help line. Depends on T012, T025.

**Checkpoint**: US1, US2, and the shareable report all work; the report is one paste-ready block.

---

## Phase 6: User Story 3 — Attendance & availability insight (Priority: P3)

**Goal**: `stats --attendance` shows each player's attendance % (attended/eligible) and the squad's average turnout per fixture, where eligible = completed poll-bearing fixtures.

**Independent Test**: Seed games with poll responses (including a completed fixture with no poll and a non-completed polled fixture); `stats --attendance` shows per-player attendance % and average turnout matching a hand calculation; the no-poll and non-completed fixtures do not skew the figures.

### Tests for User Story 3 (write FIRST, must FAIL)

- [X] T027 [P] [US3] Write failing unit tests for `aggregateAttendance` in `tests/unit/stats/aggregations.test.ts`: per-player `attendanceRate` = Yes-count / `pollFixtureCount` with `eligible == pollFixtureCount`; squad `averageTurnoutPerFixture`; poll-less and non-completed fixtures excluded; `null` when `pollFixtureCount === 0` (A8, A10). (FR-009, FR-015, Q3, SC-002, SC-004)
- [X] T028 [P] [US3] Write a failing integration test for `stats --attendance` in `tests/integration/stats/stats-aggregates.test.ts`: per-player attendance % + average turnout printed; a completed fixture with no poll is excluded from the denominator; `--json` shape matches `AttendanceReport`. (FR-009, FR-015)

### Implementation for User Story 3

- [X] T029 [US3] Implement `aggregateAttendance(input): AttendanceReport` in `src/stats/aggregations.ts`. Makes T027 pass. Depends on T002.
- [X] T030 [US3] Implement `AggregateService.getAttendance(seasonId)` in `src/services/aggregate-service.ts`. Depends on T004, T029.
- [X] T031 [P] [US3] Implement `formatAttendanceTable` and `formatAttendanceJSON` in `src/cli/output/aggregate-formatters.ts`. Depends on T002.
- [X] T032 [US3] Wire the `--attendance` view into `src/cli/commands/stats.ts` (dispatch to `getAttendance` + attendance formatter). Depends on T011, T030, T031.
- [X] T033 [US3] Extend the `stats` route in `src/cli/index.ts`: register `attendance` in minimist `boolean`; parse `--attendance`; add its help line. Depends on T012, T032.

**Checkpoint**: All four views functional and independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T034 [P] Run the [quickstart.md](./quickstart.md) manual smoke scenarios against a populated DB (all four views + edge cases + the FR-013 `aggregateReport` reuse check).
- [X] T035 Run `npm run build` (strict typecheck), `npm test` (full suite green), and `npm run format`. Confirm no regression in the legacy `stats --game` / `stats --season` raw views, and that the `--report` human output is paste-safe (no tab/box/ANSI). (Constitution II/III)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. **Blocks all user stories** (T002→T004 are prerequisites for every view; the `Participation` builder encodes the attended-games definition).
- **User Stories (Phases 3–6)**: each depends on Foundational. US1 owns the shared command shell (`stats.ts` dispatcher, `index.ts` route registration); US2/US4/US3 extend that shell. US4 (report) additionally depends on US1+US2's pure functions. Priority order: P1 (US1) → P2 (US2, US4) → P3 (US3).
- **Polish (Phase 7)**: depends on all desired stories being complete.

### Key task dependencies

- T002 → T003, T004, T008, T010, T015, T017, T022, T024, T029, T031 (everything uses the shared types/helper).
- T004 → T005, T009, T016, T023, T030 (service methods build on `getSeasonData`).
- T008 + T015 → T022 (the report composes both aggregates).
- T011 (command shell + mutual-exclusivity) → T018, T025, T032 (views plug into it).
- T012 (route registration) → T019, T026, T033 (added flags extend the route).

### Shared-file ordering (NOT parallel within these files)

- `src/stats/aggregations.ts` — T002, T008, T015, T022, T029 sequentially.
- `tests/unit/stats/aggregations.test.ts` — T003, T006, T013, T020, T027 append sequentially.
- `tests/integration/stats/stats-aggregates.test.ts` — T005, T007, T014, T021, T028 append sequentially.
- `src/services/aggregate-service.ts` — T004, T009, T016, T023, T030 sequentially.
- `src/cli/output/aggregate-formatters.ts` — T010, T017, T024, T031 sequentially.
- `src/cli/commands/stats.ts` — T011, T018, T025, T032 sequentially.
- `src/cli/index.ts` — T012, T019, T026, T033 sequentially.

### Parallel Opportunities

- **Foundational**: T002 ∥ T003 (different files); T005 [P] is a different test file from T003.
- **Within each story**: the unit-test task ∥ the integration-test task (different files), and the formatter task ([P], different file) ∥ the pure-function implementation, before the command-wiring task joins them (e.g. T006 ∥ T007; T010 ∥ T008).
- Because US1 establishes the shared command shell, US2/US4/US3 follow US1; their pure functions/formatters are independent of each other but all serialise on the shared `aggregations.ts` / `aggregate-service.ts` / `stats.ts` / `index.ts` files.

---

## Parallel Example: User Story 1

```bash
# Write both failing test files together (different files):
Task: "Unit tests for aggregateSeason in tests/unit/stats/aggregations.test.ts"            # T006
Task: "Integration tests for stats --summary in tests/integration/stats/stats-aggregates.test.ts"  # T007

# Then the independent implementation pieces (different files):
Task: "Implement aggregateSeason in src/stats/aggregations.ts"                              # T008
Task: "Implement season-summary formatters in src/cli/output/aggregate-formatters.ts"       # T010
# (T009 service → T011 command shell → T012 route follow, in order)
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational (T002–T005).
2. Phase 3 US1 (T006–T012): write tests, watch them fail, implement until green.
3. **STOP and VALIDATE**: `stats --summary --season <n>` and `--json` against a seeded season; confirm empty/missing-season exit codes and that legacy `stats --season` is unchanged.
4. Shippable MVP — the headline "season overall stats" the user asked for.

### Incremental Delivery

1. Foundation → US1 (MVP) → validate/demo.
2. Add US2 (`--players` + `--rank`) → validate/demo.
3. Add US4 (`--report`, the shareable WhatsApp block) → validate/demo.
4. Add US3 (`--attendance`) → validate/demo.
5. Polish (T034–T035).

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- Tests precede implementation and MUST fail first (Constitution II). The attended-games definition
  and the mean-of-player squad rates are pinned in the pure-core unit tests (T006, T013) and the
  service boundary test (T005) — these are the highest-risk areas of the change.
- Pure `aggregations.ts` holds the reusable calculation core (FR-013) — keep it free of Drizzle,
  I/O, and formatting so the existing `end-of-season` command can later reuse `aggregateReport`.
- The `--report` human output is chat-first: never use aligned columns/box-drawing/ANSI (FR-016).
- No schema migration, no new dependency, no new write path — read-only derivation only.
- Commit after each task or logical group.
