# Phase 0 Research: Correct Next-Fixture Selection

The technology stack is fully inherited from features 003/005 (TypeScript/Node ESM, cheerio, axios,
Drizzle + better-sqlite3, Vitest, in-repo WhatsApp Gateway). No NEEDS CLARIFICATION of the
unknown-technology kind remains. The open questions are **design placement** decisions for the
behaviour change. Each is settled below.

---

## Finding 1 — Where filtering / opponent / year logic lives

**Decision**: Keep `scrapeFixtures()` a faithful HTML→rows parser and add a **separate pure module
`src/scraping/fixture-normaliser.ts`** that consumes the parsed rows (in page order) + `TEAM_NAME` +
an injected "today", and produces our-team fixtures with correct years and derived opponents.

**Rationale**:
- The `IFixtureScraper.parseFixtures(html): Fixture[]` boundary is what every test mocks
  (`MockFixtureScraper` runs the *real* parser over static HTML). Keeping the parser's signature and
  responsibility (HTML → rows) stable means existing service-boundary tests stay valid and new logic
  is tested as a pure function — directly aligned with the constitution's "test WHAT, not HOW" and
  the `tests/README.md` parser-as-pure-function guidance.
- `scrapeFixtures` *already* extracts `homeTeam`, `awayTeam`, `homeScore`, `awayScore` — everything
  needed for filtering and opponent derivation is present; only the **business interpretation** was
  wrong (opponent hard-coded to `homeTeam`; year guessed per month).

**Alternatives considered**:
- *Filter inside `scrapeFixtures(html, teamName)`*: would change the pure boundary signature and
  push business logic + clock dependence into the parser, complicating mocks and violating the
  parser-stays-pure principle. Rejected.
- *Filter in `FixtureService` inline*: workable, but buries pure, highly-testable logic (year
  assignment, name matching, opponent derivation) inside a DB-coupled service, making the
  boundary-spanning year/boundary cases harder to unit test. Rejected in favour of a dedicated pure
  module the service calls.

---

## Finding 2 — Year assignment across the Dec→Jan boundary (FR-002)

**Decision**: Stop `extractDate()` from inferring a year from the current month. Have the parser
surface each week's **month + day** (and page order); the normaliser walks weeks in page order and
assigns calendar years by anchoring to "today" and **incrementing the year whenever the month
sequence wraps** (a month lower than the previous week's month ⇒ new calendar year).

**Rationale**: The spec's settled rule (Assumptions: "Page ordering") is that the site lists weeks in
chronological order. Year therefore follows deterministically from sequence + a single anchor (today),
which is exactly what fixes the "January treated as current year / already past" bug. This is a pure
function of `(orderedWeeks, today)` — unit-testable with a fixed `today`, no clock dependence.

**Alternatives considered**:
- *Refine the per-month heuristic* (the current `currentMonth >= 10 && month <= 2` logic): the spec
  explicitly rejects guessing each fixture's year independently (FR-002). Rejected.
- *Parse a 4-digit year from the page*: the week headers (`"Week 7 - June 29th"`) carry no year, so
  there is nothing to parse. Not viable.

---

## Finding 3 — Next-fixture selection mechanism (FR-004/FR-008)

**Decision**: Continue to **persist all our-team fixtures and select via the existing
`FixtureService.getUpcomingFixtures(seasonId)`**, which already filters `status = 'upcoming'` AND
`gameDate >= now`, ordered by `gameDate` ascending, taking the first.

**Rationale**: The two FR-004 conditions map cleanly onto existing state:
- **Unplayed (`-`)** ⇔ `status = 'upcoming'` — the scraper sets `completed` iff *both* scores are
  numeric; a `-` on either side yields `upcoming`.
- **In the future (kickoff now or later)** ⇔ `gameDate >= now` — `gameDate` includes kickoff time,
  so a game later today (not yet kicked off) is future (US3 scenario 3) and a past game still showing
  `-` (score-lag) is excluded automatically (FR-008/US3). **This is the FR-008 guard — no extra code.**

Once the date is correct (Finding 2), the opponent is correct (Finding 4), and the set is
our-team-only (Finding 1), the existing selection is correct. The reported bug was bad *inputs*
(wrong year, wrong opponent, whole-league set), not a wrong selection query.

**Alternatives considered**:
- *Select directly from the freshly-scraped list (bypass the DB)*: diverges from the persistence
  flow FR-007 requires (stat capture/history read stored games) and would duplicate the
  unplayed/future logic. Rejected — persist-then-query keeps one selection path.

---

## Finding 4 — Opponent derivation, home/away neutrality (FR-003/FR-006)

**Decision**: In the normaliser, `opponent = (normalise(homeTeam) === normalise(TEAM_NAME)) ?
awayTeam : homeTeam`. Persist only the derived `opponent` (existing `games.opponent` column); do
**not** store home/away or scores. Venue stays the existing constant.

**Rationale**: FR-006 requires identical poll content regardless of home/away, and we always play at
the same place, so home/away is irrelevant downstream — only the opponent name matters, and the
`games` schema already holds exactly that. No migration, no poll-presenter change.

**Alternatives considered**: *Add home/away + score columns to `games`*: unnecessary for any current
requirement, would force a migration, and risks FR-006 drift (tempting callers to vary text by
home/away). Rejected.

---

## Finding 5 — Name matching (FR-001)

**Decision**: Match `TEAM_NAME` against each side's visible text using **whitespace-normalised,
case-insensitive equality** (collapse internal runs of whitespace, trim, `toLowerCase()`), requiring
an exact normalised match. `TEAM_NAME` source is the loaded config value (`getEnv().teamName`),
consistent with the glossary; `teams.name` continues to mirror it.

**Rationale**: Matches the spec Assumptions ("White Team" / "yellow team" variants) and the FR-001
wording; fuzzy/partial matching is explicitly out of scope.

**FR-005 mismatch signal**: when the scrape returns ≥1 league fixture but **zero** match `TEAM_NAME`,
the normaliser/service emits a log entry stating league fixtures were present but none matched our
team (likely `TEAM_NAME` mismatch) and yields "no confirmed next fixture" (existing behaviour: no
poll, in-chat reply, logged). The log records counts/names only — never credentials or cookies
(Principle IV).

---

## Finding 6 — Retiring automatic season transition (FR-011)

**Decision**: Remove the auto-transition branch from `FixtureService.syncFixtures` (the
`shouldCreateNewSeason` → `createNewSeason` call) so fetches (`sync`/`fixtures`/`!postpoll`) only
fetch + persist into the **current** season via the existing `getOrCreateCurrentSeason`. Retire
`SeasonService.shouldCreateNewSeason` from the live path (and its dedicated 003 tests). `SyncResult`'s
`seasonTransition`/`newSeasonNumber` become always-false/undefined (or are dropped) and the `sync`
command output no longer announces transitions.

**Rationale**: Spec Clarifications + FR-011: the disappearing-fixtures signal the detector relied on
is no longer reliable once we stop loading the whole-league set. Replace, don't re-engineer.

**Alternatives considered**: *Keep the detector dormant behind a flag*: dead code with misleading
tests; the spec says retire. Rejected — remove it from the path.

---

## Finding 7 — `end-of-season` command + lazy new season (FR-010/FR-012/FR-013)

**Decision**: New `src/cli/commands/end-of-season.ts`:
1. Resolve the current season (single-operator `teamId = 1`, as other commands do).
2. If none → print "no active season to end", make no changes, exit `0` (safe no-op; covers the
   run-twice case — FR-013/US4 scenarios 5–6).
3. Otherwise display the season number about to end; **confirm by default** via an *injectable*
   prompt (`deps.confirm`, default reads a y/N from stdin). `--yes`/`--force` skips the prompt.
   Declining makes no changes.
4. On confirm, call the existing `SeasonService.endSeason(season.id)` (sets `is_current = false`,
   `end_date = now`), leaving all games/stats intact.

The **next** fixture fetch after ending lazily creates the new current season via the **already
existing** `getOrCreateCurrentSeason` (next `season_number`) and stores new fixtures there — no
placeholder season is created by the command (FR-012). This already holds in `fetchFixtures`/
`syncFixtures` once Finding 6 removes the competing auto-transition.

**Rationale**: Reuses the 003 season model + `SeasonService` operations verbatim (FR-010 / spec
Assumptions). Injectable confirmation keeps the interactive prompt test-first (constitution II) and
non-interactive use scriptable (constitution I).

**Alternatives considered**:
- *Eagerly create season N+1 inside the command*: the spec explicitly says create lazily on next
  fetch, no empty placeholder (Clarifications). Rejected.
- *Non-injectable readline prompt*: untestable without spawning a process / faking a TTY; violates
  the test-first + helper-library guidance. Rejected.

---

## Finding 8 — Deterministic "today" for testing

**Decision**: Thread an optional "now"/"today" into the normaliser (and any selection helper that
needs it) defaulting to `new Date()` in production; tests pass a fixed value. The DB-level
`getUpcomingFixtures` already uses `new Date()`; year-boundary and score-lag scenarios are exercised
by constructing fixtures relative to the injected today and asserting selection.

**Rationale**: Year assignment (FR-002) and the future-date guard (FR-008) are time-relative;
injecting "today" makes SC-003/SC-004 deterministically testable without freezing the system clock.
