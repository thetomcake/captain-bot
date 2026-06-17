# Tasks — Next-fixture selection for the availability poll (003 bug fix)

**Feature**: 003-mvp-attempt-2 · **Increment**: next-fixture selection fix (FR-002a)
**Plan**: `plan-next-fixture-selection.md` · **Spec**: `spec.md` (FR-002a + edge case)
**Data model**: `data-model.md` → "Amendment: home/away on `games`"

Standalone bug-fix increment; task IDs restart at T001 for this file. Test-first per the
constitution (write test, see it fail, implement, see it pass). Service-boundary mocking per
`tests/README.md` — `IFixtureScraper` mock + `FakeGateway`; no network.

**Single user story (US1)**: as a team member, when I trigger a poll, the system posts it for **our
team's** next game (home or away) with the correct opponent — not the earliest league fixture.

---

## Phase 1: Setup

- [ ] T001 Record the baseline by running `npm test` and noting the currently-green suite, so regressions introduced by the schema change are detectable.

## Phase 2: Foundational (blocking — schema + migration)

- [ ] T002 Add `homeTeam` (`text('home_team').notNull()`) and `awayTeam` (`text('away_team').notNull()`) columns to the `games` table in `src/database/schema.ts`, placed alongside `opponent`.
- [ ] T003 Generate the Drizzle migration for the two new `games` columns into `drizzle/` (e.g. `npx drizzle-kit generate`), and verify the new `.sql` file adds `home_team`/`away_team` and is picked up by `init` migration run.
- [ ] T004 Update the `Game` entity type in `src/types/entities.ts` to include `homeTeam: string` and `awayTeam: string`, keeping `opponent: string`.

## Phase 3: US1 — Poll targets our team's next fixture (P1)

**Goal**: keep storing all league fixtures, but select our team's next upcoming game (home or away)
with the correct opponent; poll wording/venue unchanged regardless of home/away.

**Independent test**: with `TEAM_NAME=White Team` and the season seeded from
`tests/fixtures/html/manvfat-fixtures.html`, the poll for a date that also has an earlier
non-White-Team league game still names White Team's game and a real opponent.

### Tests first (write, run, watch fail)

- [ ] T005 [P] [US1] Unit tests for opponent/our-fixture helpers in `tests/unit/scrapers/team-fixtures.test.ts`: `resolveOpponent('White Team','Red team','white team') → 'Red team'`; `resolveOpponent('Green Team','White Team','White Team') → 'Green Team'`; league-only `resolveOpponent('Green Team','Red team','White Team') → 'Red team'` (default); `isOurFixture` true for home and away appearances and false otherwise; all case-insensitive + trimmed.
- [ ] T006 [P] [US1] Integration test for team-aware selection in `tests/integration/fixtures/fixture-retrieval.test.ts`: seed from `manvfat-fixtures.html` with `TEAM_NAME=White Team`; assert `getUpcomingTeamFixtures(seasonId,'White Team')` returns only White Team's games in date order, that `getUpcomingFixtures(seasonId)` still returns the full league set (retention), and that the first team fixture's opponent is never `White Team`.
- [ ] T007 [P] [US1] Integration regression test in `tests/integration/whatsapp/poll-service.test.ts` (or `postpoll-trigger.test.ts`): via `FakeGateway` + `MockFixtureScraper`, trigger `!postpoll` on a season where an earlier non-White-Team league game exists; assert the posted poll question names White Team's next game and a real opponent (reproduces the reported bug).
- [ ] T008 [P] [US1] Integration test: a season of league-only games (no White Team) yields `no-fixture` (FR-028 in-chat reply), distinct from a fetch failure, in `tests/integration/whatsapp/poll-service.test.ts`.

### Implementation

- [ ] T009 [US1] Add a pure module `src/scraping/team-fixtures.ts` exporting `resolveOpponent(homeTeam, awayTeam, ourTeam)` and `isOurFixture(homeTeam, awayTeam, ourTeam)`, both case-insensitive/trimmed (`resolveOpponent` returns the non-us side when we play, else `awayTeam`).
- [ ] T010 [US1] In `src/scraping/fixture-scraper.ts`, surface `homeTeam`/`awayTeam` on every persisted fixture and remove the misleading `const opponent = homeTeam` guess (the page has no viewpoint); keep `scrapeFixtures` team-agnostic so existing scraper unit tests stay valid.
- [ ] T011 [US1] In `src/services/fixture-service.ts` `persistScrapedFixtures`, store `homeTeam`/`awayTeam`, compute `opponent` via `resolveOpponent(home, away, team.name)`, and change the existing-row lookup key from `(seasonId, gameDate, opponent)` to `(seasonId, gameDate, homeTeam, awayTeam)`. Update the `persistScrapedFixtures` param shape to carry `homeTeam`/`awayTeam`.
- [ ] T012 [US1] In `src/services/fixture-service.ts`, add `getUpcomingTeamFixtures(seasonId, teamName)` — like `getUpcomingFixtures` but filtered to rows where `teamName` equals `homeTeam` or `awayTeam` (case-insensitive), ordered by `gameDate`; leave `getUpcomingFixtures` unchanged for whole-league consumers.
- [ ] T013 [US1] In `src/services/poll-service.ts` `resolveNextFixture`, call `getUpcomingTeamFixtures(season.id, team.name)` instead of `getUpcomingFixtures(season.id)` and take `[0]`; verify `previewNextPoll` (`--dry-run`) inherits the fix. Poll wording (`poll-presenter.ts`) untouched.
- [ ] T014 [US1] In `src/services/season-service.ts`, change `fixtureKey` (used by `shouldCreateNewSeason`) to key on `homeTeam|awayTeam|date` so transition detection is stable now that all league rows are retained; update the `previousGames`/`scrapedFixtures` comparison accordingly.
- [ ] T015 [US1] Add a `logger.warn` in the fixtures sync path when the scrape returned league fixtures but `getUpcomingTeamFixtures` is empty for `team.name` (likely `TEAM_NAME` mismatch vs the site spelling), per the FR-028 edge case.

## Phase 4: Polish & cross-cutting

- [ ] T016 Migrate the live DB `/home/tom/watford-captain-stats.db`: per `plan-next-fixture-selection.md` → Migration, delete the current season's `games` after cascade-deleting their `polls`, `poll_responses`, and `keysets` (FK order), then run `captain-stats sync` to repopulate with `homeTeam`/`awayTeam` + correct opponent. (Discards in-flight poll/votes — acceptable pre-launch; use the conservative backfill only if votes must survive.)
- [ ] T017 Manual validation: `captain-stats poll --dry-run` against the migrated DB previews White Team's next game with the correct opponent; spot-check a week where White Team is home and one where away.
- [ ] T018 Run the full suite (`npm test`) and confirm green, including the pre-existing scraper/fixtures/poll tests adjusted for the new `homeTeam`/`awayTeam` shape.

---

## Dependencies

- Phase 2 (T002–T004) blocks everything (schema/type underpin all reads/writes).
- T009 (helpers) blocks T010–T014.
- T011 (persist home/away) blocks T012 (select), which blocks T013 (poll wiring).
- Tests T005–T008 are written before their implementation counterparts and must fail first.
- T016 (live migration) requires T002–T015 merged; T017–T018 follow it.

## Parallel opportunities

- T005, T006, T007, T008 are independent test files → `[P]`, author together before implementing.
- T002 and T004 (schema vs type) touch different files and can be done together; T003 (generated migration) depends on T002.

## MVP scope

US1 is the whole fix — there is no smaller shippable slice. Phases 1–3 deliver the corrected poll
behaviour; Phase 4 cleans the live data and verifies.

## Format validation

All tasks use `- [ ] TNNN [P?] [US1?] description + file path`; Setup/Foundational/Polish carry no
story label (per format rules); US1 tasks are labelled `[US1]`.
