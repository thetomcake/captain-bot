# Implementation Plan — Next-fixture selection for the availability poll (003 bug fix)

**Feature**: 003-mvp-attempt-2 (MVP) · **Type**: bug-fix increment · **Date**: 2026-06-17
**Scope owner**: this is an addendum to `plan.md`; it does not supersede it.

## Problem

`!postpoll` (and `poll`) can post a poll for the **wrong game**. The configured team is
e.g. `White Team` (`TEAM_NAME`), but the club fixtures page lists **the whole league** — all
teams' games, not just ours. Two defects compound:

1. **No team filter on selection.** `PollService.resolveNextFixture` calls
   `FixtureService.getUpcomingFixtures(season.id)` and takes `upcoming[0]` — the earliest
   *league* fixture by kickoff, regardless of whether our team plays in it. Confirmed against the
   live DB (`/home/tom/watford-captain-stats.db`): on **2026-07-06** the earliest upcoming game is
   `yellow team` 18:00, but White Team's actual game is 19:00 — so the poll goes out for the
   wrong fixture.
2. **Viewpoint-less opponent.** `scrapeFixtures()` hardcodes `const opponent = homeTeam` for every
   row (`src/scraping/fixture-scraper.ts`). When White Team is the **home** side, the stored
   "opponent" is literally `White Team` (us) — see live DB game id 16, opponent `White Team`.
   The poll would read `… vs White Team`.

### Decision from the user (scope)

> "It's ok to get all the games — we just need to improve our filtering. We may need the other
> fixtures later for other reasons."

So we **keep persisting the full league fixture list** (do not filter at scrape/persist time).
The fix is to (a) record enough per-game information to identify *our* games and the real
opponent, and (b) filter to our team **at selection time**. The poll message itself is
**unchanged** — venue is always the same place, so home/away must not alter the wording
(user's explicit constraint).

## Technical Context

| | |
|---|---|
| Language / runtime | TypeScript (strict), NodeNext ESM, `.js` import suffixes, `#src/*` subpaths |
| Persistence | SQLite via Drizzle (`better-sqlite3`); migrations in `drizzle/` |
| Affected modules | `src/scraping/fixture-scraper.ts`, `src/services/fixture-service.ts`, `src/services/season-service.ts`, `src/services/poll-service.ts`, `src/database/schema.ts` |
| Unchanged | `src/whatsapp/poll-presenter.ts` (poll wording), CLI command surface (`poll`, `fixtures`), Gateway seam |
| Team identity source | `teams.name`, seeded from `TEAM_NAME` (`src/cli/commands/init.ts`); already loaded by every `FixtureService` op |
| Test boundary | `IFixtureScraper` mock (`tests/helpers/mock-scraper.ts`) replays real HTML through `scrapeFixtures`; live fixture HTML `tests/fixtures/html/manvfat-fixtures.html` contains `White Team` as **both** home and away, plus mixed-case league names (`Red team`, `yellow team`, `Blue team`) — exercises both branches and case-insensitive matching with no new fixture needed |

**No NEEDS CLARIFICATION remain.** The one open scope question ("filter vs keep all fixtures") was
resolved by the user in favour of keeping all fixtures.

## Constitution Check

- **I. CLI-First** — no CLI surface change; `poll`/`fixtures` behave the same, just select the
  right game. ✅
- **II. Test-First (NON-NEGOTIABLE)** — tests written first, against requirements (FR-002a below),
  at the service boundary per `tests/README.md`. Pure selection/opponent logic is unit-tested; the
  `!postpoll`→correct-game path is integration-tested via `FakeGateway` + `MockFixtureScraper`.
  We test *which game is chosen and how the opponent is labelled* (WHAT), not cheerio parsing (HOW). ✅
- **III. TypeScript** — strict types, NodeNext, `.js` suffixes, `#src/*`. ✅

No violations; no Complexity-Tracking entries required.

## Phase 0 — Research summary

- **Where to filter.** Three candidate seams: scrape, persist, select. User requires keeping all
  league rows ⇒ **not** scrape/persist. Filtering at **select** time keeps every fixture available
  for future features (league tables, opponent history) while making the poll correct. Decision:
  filter at selection.
- **How to identify our games + the opponent.** A stored row currently carries a single,
  viewpoint-dependent `opponent` and no home/away. To know *which* league rows are ours and *who*
  the opponent is (correct whether we are home or away), the row must carry **both** team names.
  Decision: persist `home_team` and `away_team`; derive opponent relative to `teams.name`.
  Alternative considered — a boolean `is_our_game` + corrected `opponent` — rejected: it discards
  the other league teams' identities, contradicting "we may need the other fixtures later".
- **Matching robustness.** Live and fixture data use inconsistent casing (`White Team` vs
  `Red team`/`yellow team`). Decision: match team names **case-insensitively and trimmed**.
- **Dedupe identity.** Persistence currently dedupes on `(seasonId, gameDate, opponent)`. With a
  viewpoint-dependent opponent now derived from config, that key is unstable. Decision: dedupe on
  `(seasonId, gameDate, home_team, away_team)` — stable and page-faithful. Apply the same key to
  `SeasonService.shouldCreateNewSeason`'s `fixtureKey`.

## Phase 1 — Design

### Data-model delta (see `data-model.md` → "Amendment: home/away on `games`")

`games` gains two columns:

| column | type | notes |
|---|---|---|
| `home_team` | `text NOT NULL` | as printed on the club page |
| `away_team` | `text NOT NULL` | as printed on the club page |

`opponent` is **retained** and redefined as *the opponent from our team's perspective*: for a game
our team plays, the side that is not us; for a league-only game (we don't play), it defaults to
`away_team` and is never consumed (no poll, no stats). Poll wording (`formatPollQuestion`,
`game.opponent`) is unchanged — for our games `opponent` is now correct.

New Drizzle migration adds the two columns. Existing rows need backfill — see Migration below.

### Code changes

1. **Scraper (`fixture-scraper.ts`)** — already extracts `homeTeam`/`awayTeam`; surface them in the
   persisted shape. Remove the misleading `const opponent = homeTeam` guess from the page-faithful
   layer — the *page* has no opponent, only home/away. `scrapeFixtures` stays team-agnostic
   (unchanged unit tests for date/time/team parsing remain valid).

2. **New pure helper `resolveOpponent(homeTeam, awayTeam, ourTeam)`** (co-located with the scraper
   or a small `team-fixtures.ts`): case-insensitive/trimmed; returns the non-us side when we play,
   else `awayTeam`. Plus a predicate `isOurFixture(homeTeam, awayTeam, ourTeam)`. Unit-tested.

3. **`FixtureService.persistScrapedFixtures`** — accept `home_team`/`away_team`, store them, compute
   `opponent` via `resolveOpponent(.., team.name)`. Switch the existing-row lookup key to
   `(seasonId, gameDate, home_team, away_team)`.

4. **Selection** — add `FixtureService.getUpcomingTeamFixtures(seasonId, teamName)`: like
   `getUpcomingFixtures` but filtered to rows where `teamName` equals `home_team` or `away_team`
   (case-insensitive), ordered by `gameDate`. Keep `getUpcomingFixtures` as-is for whole-league
   consumers. `PollService.resolveNextFixture` calls the team-aware variant with `team.name` and
   takes `[0]`. `previewNextPoll` (`--dry-run`) inherits the fix for free.

5. **`SeasonService.shouldCreateNewSeason`** — change `fixtureKey` to `home|away|date` so the
   transition comparison is stable now that all league rows are retained.

### Migration of existing data (one-off)

Existing current-season rows have `opponent = homeTeam` and no `home_team`/`away_team`; some of our
home games are mislabelled (`opponent = White Team`). Because the new dedupe key is
`home/away/date`, a re-scrape would insert fresh correct rows and leave the stale ones — so the
old, wrong rows must be cleared.

**Recommended (simple, pre-launch):** delete the current season's `games` (cascade their `polls`,
`poll_responses`, `keysets` first to satisfy FKs), then run `captain-stats sync` to repopulate with
home/away + correct opponent. Trade-off: discards any in-flight poll + votes — acceptable for a
freshly-built MVP that has not yet shipped. Document in the task.
**Conservative alternative** (if live votes must survive): a data migration that backfills
`home_team`/`away_team` from a fresh scrape matched on date, then recomputes `opponent`.

## Quickstart / validation

Prereqs: `npm test` green before starting (record the baseline).

1. **Unit — opponent resolution**: `resolveOpponent('White Team','Red team','white team')` → `Red team`;
   `resolveOpponent('Green Team','White Team','White Team')` → `Green Team`;
   league-only `resolveOpponent('Green Team','Red team','White Team')` → `Red team` (default, unused).
2. **Unit — `isOurFixture`** true for home and away appearances, false otherwise, case-insensitive.
3. **Integration — selection**: seed the season from `manvfat-fixtures.html`, set `TEAM_NAME=White Team`;
   assert `getUpcomingTeamFixtures` returns only White Team's games in date order, and that the first
   is White Team's next game (not the earliest league game), with a non-`White Team` opponent.
4. **Integration — `!postpoll`** via `FakeGateway` + `MockFixtureScraper`: assert the posted poll's
   question names White Team's next fixture and a real opponent, on a date where an earlier
   non-White-Team league game exists (regression guard for the reported bug).
5. **Integration — no White Team fixtures**: a season of league-only games yields `no-fixture`
   (FR-028 in-chat reply), distinct from a successful fetch.
6. **Manual**: run the migration on `/home/tom/watford-captain-stats.db`, `captain-stats poll --dry-run`,
   confirm it previews White Team's next game with the correct opponent.

## Tasks pointer

Run `/speckit-tasks` to generate the dependency-ordered task list, or fold these into
`specs/003-mvp-attempt-2/tasks.md` under a new "Next-fixture selection fix" section:
schema+migration → pure helper (tests-first) → persist wiring → team-aware selection query →
poll-service wiring → season-transition key → data migration of the live DB → full-suite green.

## Contracts

No new or changed contracts — the `poll` and `fixtures` CLI command schemas and the WhatsApp
Gateway interaction are unchanged. (Existing `specs/003-mvp-attempt-2/contracts/` stands.)
