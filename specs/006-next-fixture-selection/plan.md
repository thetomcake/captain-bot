# Implementation Plan: Correct Next-Fixture Selection for Our Team

**Branch**: `006-next-fixture-selection` | **Date**: 2026-06-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-next-fixture-selection/spec.md`

## Summary

Fix how the system identifies "our team's next fixture" (the fixture an availability poll is
posted for) and how it loads fixtures from the club site. Three corrections plus a season-rollover
change:

1. **Filter to our team on load** (FR-001): keep only fixtures featuring `TEAM_NAME` (home or
   away), discard other league pairings, matching name whitespace-normalised + case-insensitively.
2. **Correct opponent derivation** (FR-003): the opponent is the *other* side, whether we are home
   or away — not always the home team.
3. **Correct year assignment across the Dec→Jan boundary** (FR-002): assign each fixture's calendar
   year from the page's chronological week ordering anchored to today, instead of guessing each
   month's year independently.
4. **Next fixture = unplayed (`-`) AND future** (FR-004/FR-008): a past game still showing `-`
   (≤5-day score-publishing lag) is excluded by the future-date condition.
5. **Manual season rollover** (FR-010–FR-013): retire the MVP's automatic season-transition detector
   (`shouldCreateNewSeason`) and replace it with a CLI `end-of-season` command (confirm by default,
   `--yes`/`--force` to skip), reusing the existing `seasons` table and `SeasonService` unchanged.

**Technical approach**: Keep `scrapeFixtures()` a faithful HTML→rows parser (it already extracts
`homeTeam`/`awayTeam`/`homeScore`/`awayScore`), but stop it from collapsing each week to a guessed
year. Add a **pure, unit-testable normalisation step** that, given the parsed weeks in page order +
`TEAM_NAME` + "today", assigns correct years, filters to our fixtures, and derives the opponent.
Persistence and the `games`/`seasons` schema are **unchanged** (no migration) — our team's fixtures
(including played ones) are still stored across the season (FR-007), and next-fixture selection
continues to use the existing `getUpcomingFixtures` (status `upcoming` = unplayed, `gameDate >= now`
= future). The poll wording/options/venue are reused verbatim (FR-006). `resolveNextFixture` /
`syncFixtures` drop the auto-transition branch; a new `end-of-season` command becomes the sole
season-boundary trigger.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ≥ 22, ESM (`"type": "module"`)

**Primary Dependencies**: cheerio (HTML parsing), axios (HTTP), drizzle-orm + better-sqlite3
(storage), minimist (CLI args), in-repo WhatsApp Gateway via `IWhatsAppGateway` port. No new
dependencies.

**Storage**: SQLite via Drizzle. **No schema change** — reuses `seasons` (`season_number`,
`is_current`, `start_date`, `end_date`) and `games` (`opponent`, `game_date`, `venue`, `status`).

**Testing**: Vitest. Service-boundary mocking per `tests/README.md` — real `scrapeFixtures` behind
`MockFixtureScraper` (`IFixtureScraper`) over **static representative HTML** fixtures. The
year-boundary/score-lag cases are date-relative and made deterministic by **faking the clock** — an
injectable "now"/"today" threaded through the normaliser and the selection guard — NOT by generating
HTML (see Clarifications; dynamic HTML generation is out of scope as overkill). Real in-memory SQLite
(`:memory:`); `FakeGateway` for any WhatsApp path. No live network. Pure normalisation/selection logic
tested directly as functions.

**Target Platform**: Linux/macOS CLI (single-operator) + long-running `daemon`.

**Project Type**: Single project (CLI + services + scraping + WhatsApp), structure unchanged.

**Performance Goals**: Not performance-sensitive; correctness feature. No new perf thresholds.

**Constraints**: Constitution NodeNext + `.js` import extensions + `#src/*` subpath imports;
deterministic "now"/"today" must be injectable so year-boundary and score-lag cases are testable
against static fixtures without real-clock dependence; configuration is read via the loaded config
object (`getEnv()` / `EnvironmentConfig`), not direct `process.env` access; no new configuration
(`TEAM_NAME` reused); interactive confirmation in `end-of-season` must be injectable for tests.

**Scale/Scope**: One league division of fixtures per scrape; one team of interest; tens of fixtures
per season.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| **I. CLI-First** | `end-of-season` is a new CLI subcommand following Unix conventions (stdout/stderr, exit codes, `--yes`/`--force` for non-interactive use, `--json` where appropriate). All other behaviour remains CLI/chat-triggered. | ✅ PASS |
| **II. Test-First (NON-NEGOTIABLE)** | Tasks ordered tests-first. Behaviour verified at the fixture-scraper service boundary with representative league HTML (home/away variants, year-boundary spans, score-lag) + pure-function tests for normalisation/selection. Tests assert FR-/SC- requirements (WHAT), not cheerio/regex internals (HOW). Uses the standard helper library + service-boundary mocking from `tests/README.md`. | ✅ PASS |
| **III. TypeScript** | All code TypeScript strict; NodeNext; relative imports carry `.js`; `#src/*` subpath imports; no `../../../`. | ✅ PASS |
| **IV. Security-First (NON-NEGOTIABLE)** | No new credentials, no auth changes; MAN v FAT auth path (feature 005) untouched and stays below the `IFixtureScraper` boundary. No secrets logged (the FR-005 mismatch log records counts/names, never cookies/credentials). | ✅ PASS |

**Result**: PASS — no violations. Complexity Tracking not required.

*Post-Phase-1 re-check*: PASS — the design adds one pure module + one CLI command and removes the
auto-transition branch; no new architecture, no schema migration, no new dependency. Gates still
hold.

## Project Structure

### Documentation (this feature)

```text
specs/006-next-fixture-selection/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output (/speckit-plan)
├── data-model.md        # Phase 1 output (/speckit-plan)
├── quickstart.md        # Phase 1 output (/speckit-plan)
├── contracts/           # Phase 1 output (/speckit-plan)
│   ├── fixture-selection.md   # scraper/normaliser/selection behavioural contract
│   └── cli-end-of-season.md   # end-of-season CLI command contract
├── checklists/          # (pre-existing)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── scraping/
│   └── fixture-scraper.ts        # MODIFY: stop per-fixture year guessing; emit week month/day +
│                                 #   home/away/scores faithfully (parser stays pure)
├── scraping/
│   └── fixture-normaliser.ts     # NEW (pure): assign correct years from page order anchored to
│                                 #   today; filter to TEAM_NAME; derive opponent (FR-001/002/003)
├── services/
│   ├── fixture-service.ts        # MODIFY: apply normaliser on load; drop auto-transition from
│   │                             #   syncFixtures; preserve persistence of our fixtures (FR-007)
│   └── season-service.ts         # MODIFY: retire shouldCreateNewSeason usage; endSeason reused
├── services/
│   └── poll-service.ts           # MODIFY: resolveNextFixture no longer triggers a season transition
├── cli/
│   ├── index.ts                  # MODIFY: route + help for `end-of-season`
│   └── commands/
│       └── end-of-season.ts      # NEW: confirm-by-default season rollover (FR-010/FR-013)
└── config/                       # unchanged (TEAM_NAME reused)

tests/
├── unit/
│   ├── scrapers/                 # year assignment, TEAM_NAME filter, opponent derivation
│   └── services/                 # next-fixture selection, no auto-transition, end-of-season service path
└── integration/
    ├── fixtures/                 # league HTML → our-team fixtures, boundary + score-lag scenarios
    ├── seasons/                  # end-of-season + lazy new-season-on-next-fetch
    └── cli/                      # end-of-season command (confirm / --yes / no-current-season)
```

**Structure Decision**: Single-project layout (existing). One new pure module
(`fixture-normaliser.ts`) and one new CLI command (`end-of-season.ts`); the rest are targeted
modifications to existing scraper/services/CLI. No schema migration.

## Complexity Tracking

> No Constitution Check violations — section intentionally empty.
