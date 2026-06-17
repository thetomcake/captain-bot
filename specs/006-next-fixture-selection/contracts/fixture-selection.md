# Contract: Fixture Loading, Normalisation & Next-Fixture Selection

Behavioural contract for the corrected fixture pipeline. Verified at the `IFixtureScraper` service
boundary with static league HTML (per `tests/README.md`) plus direct pure-function tests of the
normaliser. No live network.

## C1 — Scraper stays a faithful parser (`scrapeFixtures`)

> **Division of labour (re: FR-001):** the *system* filters to `TEAM_NAME` — but the filtering
> happens in the **normaliser (C2)**, not in this low-level HTML parser. `scrapeFixtures` is the pure
> `(html) → Fixture[]` boundary every test mocks; keeping it unfiltered (returns every league row)
> means the TEAM_NAME filter is one testable pure function, not logic buried in cheerio parsing.
> "We only load our team's fixtures" (FR-001) is satisfied by C1 **+** C2 together — see research §1.

- **Input**: club-page HTML (whole-league fixtures, grouped into weeks).
- **Output**: one row per league fixture with `homeTeam`, `awayTeam`, `homeScore?`, `awayScore?`,
  `time`, and the week's month/day; `status = completed` iff both scores numeric, else `upcoming`.
- This parser MUST NOT itself filter by team, MUST NOT hard-code the opponent, and MUST NOT guess
  each fixture's year from the current month — those interpretations are the normaliser's job (C2).
  "Fixtures to be confirmed" placeholder rows continue to be skipped (unchanged).

## C2 — Normaliser (`fixture-normaliser.ts`, pure)

Signature shape: `normaliseOurFixtures(parsed, teamName, today) → OurFixture[]` (+ a way to surface
"league fixtures present but none ours").

- **FR-001 filter**: keep only fixtures where `TEAM_NAME` is home or away (whitespace-normalised,
  case-insensitive); discard all-other pairings.
- **FR-003 opponent**: `opponent` = the side that is not `TEAM_NAME`, whether we are home or away.
- **FR-002 year**: assign each fixture's calendar year from page order anchored to `today`,
  incrementing on month wrap (Dec→Jan ⇒ next year). MUST NOT guess year per month independently.
- **FR-005 mismatch**: when input has ≥1 fixture but none feature `TEAM_NAME`, signal "none matched"
  so the caller logs a likely `TEAM_NAME` mismatch and treats it as no-fixture. Logs carry
  counts/names only — never secrets.

## C3 — Selection (`getUpcomingFixtures`, existing)

Given persisted our-team games, the **next fixture** is the soonest game that is BOTH `status =
upcoming` (unplayed `-`) AND `gameDate >= now` (kickoff now or later).

- A past game still showing `-` (≤5-day score lag) is **never** selected (FR-008/SC-004) — excluded
  by `gameDate >= now`.
- A game later **today** not yet kicked off **is** selected (US3 scenario 3).
- Across the year boundary, the genuine soonest future unplayed game is selected (FR-002/SC-003).
- When no our-team future unplayed game exists → "no confirmed next fixture" (existing behaviour).

## C4 — Persistence & downstream (FR-007)

Our team's fixtures (including completed) remain stored across the season. Stat capture
(most-recent played game) and historical fixture/stat views consume the corrected data unchanged.
Persistence is NOT reduced to a single row.

## C5 — Poll content neutrality (FR-006)

Poll question, options, and venue text are identical whether we are home or away. The home/away
distinction never alters poll content. `buildPollSpec`/poll-presenter unchanged.

## Acceptance mapping

| Scenario | Covered by |
|----------|-----------|
| US1 AS1 (our next ≠ earliest league game) | C2 filter + C3 |
| US1 AS2/AS3 (home / away → correct opponent) | C2 opponent |
| US1 AS4 (none match `TEAM_NAME`) | C2 mismatch + C3 no-fixture |
| US2 AS1–AS3 (year boundary) | C2 year + C3 |
| US3 AS1–AS3 (score-lag past `-`, later-today) | C3 future-date guard |
| FR-006 / SC-006 (home vs away poll text) | C5 |
| FR-007 / SC-007 (persistence, no regression) | C4 |
