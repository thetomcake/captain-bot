---
description: "Task list for Correct Next-Fixture Selection for Our Team"
---

# Tasks: Correct Next-Fixture Selection for Our Team

**Input**: Design documents from `/specs/006-next-fixture-selection/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: REQUIRED. Constitution Principle II (Test-First, NON-NEGOTIABLE) + the spec's Testing
assumption mandate service-boundary tests written before implementation. Tests use **static** HTML
fixtures + a **faked clock** (injectable `now`/`today`) for the date-relative cases — no dynamic HTML
generation (Clarifications 2026-06-17).

**Organization**: Tasks grouped by user story. Priorities: US1 = P1 (MVP), US2 = P2, US4 = P2,
US3 = P3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 / US4
- All paths relative to repo root. Imports use `#src/*` subpaths + `.js` extensions (Constitution III).

## Path Conventions

Single project: `src/`, `tests/` at repo root (per plan.md Structure Decision). **No DB migration**
(reuses existing `seasons`/`games` schema).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the regression baseline before any change (SC-007).

- [ ] T001 Confirm baseline on branch `006-next-fixture-selection`: run `npm run build` and `npm test`; record the current green suite as the no-regression baseline for SC-007. No new dependencies are added by this feature.

---

## Phase 2: Foundational (Blocking Prerequisites for US1–US3)

**Purpose**: Shared scraping + test infrastructure the fixture-pipeline stories (US1, US2, US3) all
depend on. **US4 does NOT depend on this phase** (it touches only season-service + CLI) and may start
right after Phase 1.

**⚠️ CRITICAL**: US1, US2, and US3 cannot begin until this phase is complete.

- [ ] T002 [P] Add small **static** HTML fixtures under `tests/fixtures/html/` (clone/trim the existing `manvfat-fixtures.html`) covering the layouts the stories need: home/away variants, our-next-≠-earliest-league-game, a year-boundary span (Dec + Jan weeks), a score-lag row (past week still `-`), and a no-`TEAM_NAME` list. These match the markup `scrapeFixtures` parses (`.group-header.white`, `table.fixture-table`, `tr.no-highlight`, `td.team-name`, `td.score`, `td.game-week-no`). **Do NOT build a dynamic HTML generator** — date-relative cases are handled by faking the clock, not the HTML (Clarifications 2026-06-17).
- [ ] T003 [P] Write FAILING parser unit tests in `tests/unit/scrapers/fixture-scraper.test.ts` (using the T002 static fixtures): `scrapeFixtures` returns one row per league fixture with faithful `homeTeam`/`awayTeam`/`homeScore`/`awayScore` + the week's month/day, sets `status = completed` iff both scores numeric (else `upcoming`), skips "Fixtures to be confirmed" rows, and does NOT guess each fixture's year from the current month (contract C1).
- [ ] T004 Refactor `src/scraping/fixture-scraper.ts` to satisfy T003: keep the parser faithful (retain home/away teams + scores), surface each week's month+day, and remove the per-fixture year inference from `extractDate` (the normaliser assigns the year). Keep it pure — no team filtering, no opponent hard-coding (delete the `opponent = homeTeam` assumption), no clock dependence below the `IFixtureScraper` boundary (research §1/§2).

**Checkpoint**: Faithful parser + static HTML fixtures ready — US1/US2/US3 can begin.

---

## Phase 3: User Story 1 - Poll targets our team's next game (Priority: P1) 🎯 MVP

**Goal**: A triggered poll targets **our team's** soonest unplayed future game (home or away), with
the opponent set to the other side; when no fixture features `TEAM_NAME`, no poll is posted and a
likely-mismatch log is emitted. Poll content is identical home vs away.

**Independent Test**: Use a static league HTML fixture (same calendar year — no boundary) where our
team's next game is *not* the earliest league game and where we are home in one game and away in
another, with a fixed `now`;
verify selection targets our soonest unplayed future game with the correct opponent, the no-match
case yields "no confirmed next fixture" + a mismatch log, and poll text is unchanged by home/away.

### Tests for User Story 1 (write FIRST, ensure they FAIL) ⚠️

- [ ] T005 [P] [US1] FAILING unit tests in `tests/unit/scrapers/fixture-normaliser.test.ts` (static fixtures + a fixed `today`): whitespace-normalised case-insensitive `TEAM_NAME` matching keeps only our fixtures and discards other-team pairings (FR-001); opponent is the non-`TEAM_NAME` side whether we are home or away (FR-003); a league list with ≥1 fixture but none matching surfaces a "none matched" signal (FR-005). All cases use a fixed `today` within a single calendar year (no boundary).
- [ ] T006 [P] [US1] FAILING integration tests in `tests/integration/fixtures/next-fixture-us1.test.ts` (real `scrapeFixtures` over static fixtures behind `MockFixtureScraper` + in-memory DB, with a controlled `now`): our next game is selected even when it is not the earliest league game (US1 AS1); opponent correct for home and away (AS2/AS3); no-`TEAM_NAME` case → no confirmed next fixture + mismatch log, no poll (AS4/FR-005); poll content (question/options/venue via `buildPollSpec`) is byte-identical for a home vs away fixture (FR-006/SC-006).

### Implementation for User Story 1

- [ ] T007 [US1] Create the pure normaliser `src/scraping/fixture-normaliser.ts`: `normaliseOurFixtures(parsed, teamName, today)` → our-team fixtures with derived opponent + `status`; `normalise(x) = x.trim().replace(/\s+/g,' ').toLowerCase()` matching (FR-001); `opponent = homeMatches ? awayTeam : homeTeam` (FR-003); also returns/flags "league fixtures present but none ours" for FR-005. (Year assignment is added in US2 — for now assign the parser's provisional year so US1's same-year tests pass.)
- [ ] T008 [US1] Wire the normaliser into the load path in `src/services/fixture-service.ts`: after `parseFixtures(...)` in `fetchFixtures` AND `syncFixtures`, apply `normaliseOurFixtures` with the team name read from the **loaded config** (`getEnv().teamName`, not `process.env` — Clarifications) + an injectable `now`, so only our fixtures (with derived opponent) are persisted — preserving storage of all our fixtures incl. played ones (FR-007). Thread an injectable `now` (default `new Date()`) into `getUpcomingFixtures` and pass `today` to the normaliser so the year-boundary and score-lag cases are testable against static fixtures by faking the clock. (Touches `fixture-service.ts` — coordinate with T019 which edits a different method of the same file.)
- [ ] T009 [US1] In `src/services/fixture-service.ts`, when the scrape returned ≥1 league fixture but none match `TEAM_NAME`, emit a `logger` entry stating league fixtures were present but none matched our team (likely `TEAM_NAME` mismatch) — counts/names only, never credentials/cookies (FR-005, Principle IV). Confirm the downstream "no confirmed next fixture" path (`PollService.resolveNextFixture` → `getUpcomingFixtures` empty) holds unchanged.

**Checkpoint**: US1 fully functional — polls target our team's next game with the right opponent;
no-match handled. MVP deliverable. (Within a single calendar year; boundary handled in US2.)

---

## Phase 4: User Story 2 - Next fixture correct across the year boundary (Priority: P2)

**Goal**: Across a season spanning 31 Dec → 1 Jan, each fixture is assigned the correct calendar
year from chronological page order, so a January fixture is recognised as future, never as past.

**Independent Test**: With a static fixture spanning December into January (all unplayed) and `now`
set to late December, verify the late-Dec game is selected as next and January is a later future
fixture; when the Dec game shows a score and January is still `-`, January is selected.

### Tests for User Story 2 (write FIRST, ensure they FAIL) ⚠️

- [ ] T010 [P] [US2] FAILING unit tests in `tests/unit/scrapers/fixture-normaliser.test.ts` (extend): with `today` in late December and weeks running December→January in page order, `normaliseOurFixtures` assigns December the current year and January the next year (increment on month wrap), independent of any per-month guess (FR-002).
- [ ] T011 [P] [US2] FAILING integration tests in `tests/integration/fixtures/year-boundary-us2.test.ts`: late-Dec `today`, Dec + Jan unplayed → Dec selected as next, Jan recognised as later future (US2 AS1); Dec now played (score) + Jan unplayed → Jan selected (US2 AS2); chronological ordering correct across 31 Dec → 1 Jan (US2 AS3/SC-003).

### Implementation for User Story 2

- [ ] T012 [US2] Add chronological year assignment to `src/scraping/fixture-normaliser.ts`: walk the parsed weeks in page order, anchor the year to `today`, and increment the year whenever a week's month is lower than the previous week's month (Dec→Jan wrap), replacing the provisional year from T007 (FR-002, research §2). (Modifies the file created in T007 — depends on US1.)

**Checkpoint**: US1 + US2 work — selection correct within a year and across the Dec→Jan boundary.

---

## Phase 5: User Story 3 - Recently-played game with pending score not chosen (Priority: P3)

**Goal**: A game already played but still showing `-` (≤5-day score lag) is excluded from selection;
a game later today not yet kicked off is selectable.

**Independent Test**: Feed fixtures where the most recent game is in the past but still `-`, plus a
genuine future game; verify the past `-` game is ignored and the future game is selected.

### Tests for User Story 3 (write FIRST, ensure they FAIL/PASS-as-guard) ⚠️

- [ ] T013 [P] [US3] FAILING integration tests in `tests/integration/fixtures/score-lag-us3.test.ts` (static score-lag fixture + a faked `now` chosen between the past and future weeks): a past game still showing `-` plus a later future game → future selected, past `-` ignored (AS1/SC-004); only-`-`-fixture-is-past → no confirmed next fixture (AS2); a game later **today** not yet kicked off → treated as upcoming and selected (AS3).

### Implementation for User Story 3

- [ ] T014 [US3] Confirm the future-date guard in the selection path: `FixtureService.getUpcomingFixtures` filters `status = 'upcoming'` AND `gameDate >= now` (using the injectable `now` introduced in T008), and `parseGameDateTime` stores date **+ kickoff time** so "later today" counts as future (FR-008/FR-004, research §3). Make the minimal fix only if T013 reveals a gap (e.g. time-of-day not honoured); otherwise document that the guard is satisfied by the existing query once US1/US2 corrected the inputs. (`src/services/fixture-service.ts`.)

**Checkpoint**: US1 + US2 + US3 — selection is correct for boundary and score-lag cases.

---

## Phase 6: User Story 4 - Manually roll over to a new season (Priority: P2)

**Goal**: A CLI `end-of-season` command (confirm by default, `--yes`/`--force` to skip) ends the
current season, and the next fetch lazily starts the next season — replacing the retired automatic
season-transition detector so fetches never roll over on their own.

**Independent Test**: Seed a current season with games; run `end-of-season` (confirm) → season marked
ended + preserved; fetch fixtures → new season created, new fixtures land there, previous untouched;
repeated fetches trigger no transition.

**Note**: Independent of US1–US3 (touches `season-service`, `fixture-service.syncFixtures`, CLI);
may start right after Phase 1.

### Tests for User Story 4 (write FIRST, ensure they FAIL) ⚠️

- [ ] T015 [P] [US4] FAILING command tests in `tests/integration/cli/end-of-season.test.ts` (in-memory DB, injected `confirm`): confirm-by-default ends the season only when confirmed and is a no-op when declined (AS3); `--yes`/`--force` skips the prompt (AS4); no current season → reports "no active season to end", no changes, exit 0 (AS5); JSON output shape per contract.
- [ ] T016 [P] [US4] FAILING integration tests in `tests/integration/seasons/manual-rollover-us4.test.ts`: `endSeason` marks `is_current=false` + sets `end_date`, preserving the season's games/stats (AS1/SC-008); the next `fetchFixtures`/`syncFixtures` lazily creates the next `season_number` via `getOrCreateCurrentSeason` and stores new fixtures there, previous season unmodified (AS2/FR-012); repeated fetches within a season trigger NO automatic transition (AS6/SC-009).

### Implementation for User Story 4

- [ ] T017 [US4] Create `src/cli/commands/end-of-season.ts`: resolve current season (teamId 1); if none → message + no change + exit 0; else display the season number and confirm via injectable `deps.confirm?: () => Promise<boolean>` (default reads y/N from stdin), bypassed by `--yes`/`--force`; on proceed call `SeasonService.endSeason(season.id)`; support `--json`; exit codes per `contracts/cli-end-of-season.md` (FR-010/FR-013). Any settings needed are read via the loaded config (`getEnv()`), not direct `process.env` access (Clarifications).
- [ ] T018 [US4] Register the `end-of-season` command in `src/cli/index.ts`: route to `endOfSeasonCommand`, parse `--yes`/`--force`/`--json`, add command-level `--help`, and add it to the usage/commands list.
- [ ] T019 [US4] Retire the automatic season transition in `src/services/fixture-service.ts`: remove the `shouldCreateNewSeason` → `createNewSeason` branch from `syncFixtures` so it only fetches + persists into the current season via `getOrCreateCurrentSeason`; adjust `SyncResult` (drop or always-false `seasonTransition`/`newSeasonNumber`) (FR-011). (Same file as T008 — different method; coordinate edits.)
- [ ] T020 [US4] Update `src/cli/commands/sync.ts` to stop announcing season transitions (consume the adjusted `SyncResult`); verify lazy new-season creation still occurs on fetch (FR-012).
- [ ] T021 [US4] Retire `SeasonService.shouldCreateNewSeason` (and its helpers `fixtureKey`/`toDateKey` if now unused) from `src/services/season-service.ts`, and remove/retire its dedicated 003 tests so the suite reflects manual-only rollover (FR-011). Leave `endSeason`/`getOrCreateCurrentSeason`/`createNewSeason` intact.

**Checkpoint**: All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T022 [P] Sweep for any remaining consumers of the removed auto-transition (`seasonTransition`/`newSeasonNumber`, `shouldCreateNewSeason`) across `src/` and `tests/`; remove dead references (FR-011).
- [ ] T023 Run the full suite (`npm run build && npm test`) and confirm green with no regressions vs the T001 baseline (SC-007); fix any fallout.
- [ ] T024 Execute the `quickstart.md` validation scenarios (US1–US4 tables), including the `end-of-season` manual checks, and confirm expected outcomes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: After Setup. BLOCKS US1, US2, US3. (Does NOT block US4.)
- **US1 (Phase 3)**: After Phase 2. MVP.
- **US2 (Phase 4)**: After US1 (extends `fixture-normaliser.ts` created in T007).
- **US3 (Phase 5)**: After US1 (needs corrected our-team selection inputs); independent of US2.
- **US4 (Phase 6)**: After Setup only — independent of Phase 2 and US1–US3.
- **Polish (Phase 7)**: After all desired stories complete.

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational. No dependency on other stories.
- **US2 (P2)**: Builds on US1's normaliser. Independently testable (boundary scenarios).
- **US3 (P3)**: Builds on US1's pipeline. Independently testable (score-lag scenarios).
- **US4 (P2)**: Fully independent of US1–US3; can be delivered in parallel.

### Within Each User Story

- Tests written FIRST and observed to FAIL before implementation (Constitution II).
- Normaliser before service wiring; service before CLI; core before integration.

### File-conflict notes

- `src/services/fixture-service.ts`: T008 (US1, load path) and T019 (US4, `syncFixtures` transition) edit **different methods** — sequence them, do not run in parallel.
- `src/scraping/fixture-normaliser.ts`: T007 (US1) then T012 (US2) edit the same file — sequential.

### Parallel Opportunities

- Phase 2: T002 + T003 in parallel (helper + test, different files), then T004.
- US1 tests: T005 + T006 in parallel.
- US2 tests: T010 + T011 in parallel.
- US4 tests: T015 + T016 in parallel.
- **Cross-story**: US4 (Phase 6) can run fully in parallel with Phase 2 + US1–US3, since it shares no files with the fixture pipeline (different developer/agent).

---

## Parallel Example: User Story 1

```bash
# After Phase 2, write US1 tests together (different files):
Task: "Unit tests for normaliser filter+opponent+no-match in tests/unit/scrapers/fixture-normaliser.test.ts"
Task: "Integration tests for US1 in tests/integration/fixtures/next-fixture-us1.test.ts"

# Then implement US1 sequentially (shared files):
Task: "Create normaliser in src/scraping/fixture-normaliser.ts"
Task: "Wire normaliser into FixtureService load path"
Task: "Emit FR-005 mismatch log"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & VALIDATE**: polls target our
   team's next game with the correct opponent; no-match handled. Demo-ready.

### Incremental Delivery

1. Setup + Foundational → faithful parser + test helper ready.
2. US1 → MVP (correct team/opponent selection).
3. US2 → year-boundary correctness.
4. US3 → score-lag exclusion.
5. US4 → manual season rollover (deliverable in parallel from the start).

### Parallel Team Strategy

- Developer/agent A: Phase 2 → US1 → US2 → US3 (the fixture pipeline).
- Developer/agent B: US4 (end-of-season + retire auto-transition) — starts immediately after Setup.
- Reconcile the two `fixture-service.ts` edits (T008 vs T019) before Polish.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- No DB migration — `seasons`/`games` schema reused (data-model.md).
- No new config — `TEAM_NAME` reused; no new dependencies. Read settings via the loaded config (`getEnv()`), not direct `process.env` access (Clarifications 2026-06-17).
- Date-relative cases are made deterministic by faking the clock (injectable `now`/`today`) against **static** HTML fixtures — no dynamic HTML generation (Clarifications 2026-06-17).
- Logs in the FR-005 path carry counts/names only — never credentials/cookies (Principle IV).
- Verify each test fails before implementing; commit after each task or logical group.
