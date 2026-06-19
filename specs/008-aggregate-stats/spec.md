# Feature Specification: Aggregated Statistics

**Feature Branch**: `008-aggregate-stats`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "I want a new feature to provide better aggregated statistics, so stuff like season overall stats, like total goals, goals per game, weight loss %, attendance %, based on the data we have. Examine the data model, to identify potentially interesting statistics. Right now I only want these to be options within the CLI with the potential expand them to other areas."

## Overview

Today the captain can list raw per-game stat lines for a player or a season (`stats --game` / `stats --season`), with only simple season totals (goals, assists) computed in the view layer. There is no way to see roll-up numbers that describe how the team or an individual player is doing across a whole season — totals, per-game rates, attendance, and the lifestyle metrics (weight direction, food tracking) the club cares about.

This feature adds **aggregated statistics**: derived, season-wide summaries computed from data already captured — games, stat records, and availability poll responses. The first delivery surface is the CLI. The summaries are designed so the same calculations can later be reused in other surfaces (e.g. a WhatsApp end-of-season message) without rework.

### Statistics identified from the data model

The data model supports the following derivable metrics (the captain does not need all of them in v1, but they bound the design space):

**Team / season aggregates**
- Total goals and assists scored by the squad in a season
- Goals per completed game (squad scoring rate)
- Games played, by status (completed / cancelled / upcoming)
- Squad size — distinct players with any recorded activity in the season
- Average turnout per fixture (availability)
- Squad weight-loss rate and food-tracking rate (see clarifications)

**Per-player aggregates (season-scoped in v1; all-time deferred)**
- Total goals, total assists, total goal contributions (goals + assists)
- Games played
- Goals per game and assists per game
- Attendance % (see clarifications)
- Weight-loss rate % and food-tracking rate % (see clarifications)

**Leaderboards** (ordering of the per-player aggregates)
- Top scorer, most assists, best attendance, best weight-loss rate

## Clarifications

### Session 2026-06-19

- Q: How should the aggregate views be surfaced in the CLI (FR-001)? → A: Extend the existing `stats` command with new flags/modes (summary / players / attendance), reusing its season-selector and `--json` plumbing.
- Q: What is the denominator for a player's per-game rates (goals/game, assists/game)? → A: Completed games the player responded "available/yes" to in the availability poll; a poll-attended game with no stat record counts as a 0-goal/0-assist game (zeros, not excluded).
- Q: What counts as an "eligible fixture" in a player's attendance % denominator (FR-009)? → A: Completed games in the season that had an availability poll; fixtures with no poll are excluded from the denominator (consistent with FR-015).
- Q: Is the all-time per-player scope in scope for v1, or season-only? → A: Season-only in v1; all-time is deferred to a later iteration (the calc layer stays reusable per FR-013 so it can be added without rework).
- Q: How is the squad weight-loss rate rolled up, and what is the per-player weight-loss denominator? → A: Squad rate = mean of each player's down%; a player's down% = `down ÷ all of that player's stat reports` (reports with `unknown` or `up`/`same` direction count against the player, i.e. are NOT excluded). This overrides the earlier rule that excluded `unknown` weight reports from the denominator; the `unknown`-exclusion rule (FR-010) now applies only to food-tracking. **(Superseded by the clarification below — denominator is now "attended games", not "all reports".)**
- Q: Add a shareable, single-output report for chat? → A: Yes — a new `stats --report` mode emits, in one invocation, a single contiguous plain-text block (no pager/columns/ANSI) safe to paste into WhatsApp, plus a `--json` form. It contains a team section (avg attendance per game, total goals/assists, avg goals/assists per game, avg weight-loss % per week, avg food-tracking % per week — all over attended players only) and a per-player breakdown (avg goals/assists per attended game, food-tracking % of attended games, weight-loss % of attended games). "per week" = the squad-level rate across attended games (fixtures are ~weekly).
- Q: Reconcile the report's "of attended games" with the just-agreed weight-loss/tracking denominator? → A: Unify on **attended games** everywhere — for every per-player rate (aggregate view AND report): weight-loss % = `(attended games with weightDirection=down) ÷ attended games`; food-tracking % = `(attended games with food tracked) ÷ attended games`. This supersedes the previous bullet's "÷ all reports" and FR-010's null-exclusion: an attended game with unknown weight / missing food data counts as a non-`down` / non-tracked game, not an exclusion. Squad lifestyle rates remain the mean of per-player rates.
- Q: How is missing/null food-tracking data treated? → A: As a **NO (not tracked)** — the same default rule as `goals = 0`. When an attended game has no stat record, or the record's `foodTracking` is null, it is treated as `false` (not tracked) and counts toward the food-tracking denominator as a non-tracked game. (Food tracking is therefore a plain boolean default, with no separate "unknown" state — unlike weight direction.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Season team summary (Priority: P1)

As the captain, I want to see a single season-wide summary of the team's headline numbers, so I can understand at a glance how the season is going and share the highlights.

**Why this priority**: This is the core "season overall stats" the user explicitly asked for (total goals, goals per game). It delivers value on its own — one command, one readable summary — and is the foundation the other stories build on.

**Independent Test**: Seed a season with several completed games and stat records, run the season-summary command for that season, and confirm the totals and per-game rates match the seeded data.

**Acceptance Scenarios**:

1. **Given** a season with completed games and recorded stats, **When** the captain requests the season summary, **Then** the output shows total goals, total assists, games played, and goals per game for that season.
2. **Given** a season selector for a past (non-current) season, **When** the captain requests the summary, **Then** the historical season's aggregates are shown (works for any season, not only the current one).
3. **Given** a season with no recorded stats, **When** the captain requests the summary, **Then** the command reports that there is no data rather than failing or showing misleading zeros as if games were played and no one scored.
4. **Given** the `--json` flag, **When** the captain requests the summary, **Then** the same figures are emitted as structured JSON.

---

### User Story 2 - Per-player aggregated stats & leaderboards (Priority: P2)

As the captain, I want per-player season aggregates (totals, per-game rates, attendance and lifestyle rates) and the ability to rank players, so I can recognise top performers and track individual progress.

**Why this priority**: Builds directly on the same captured data and is the natural second view, but the team summary (P1) is the headline ask, so this follows.

**Independent Test**: Seed a season with multiple players and varying stat records, run the per-player aggregate command, and confirm each player's totals, per-game rates, and rates are correct and that ordering reflects the requested ranking.

**Acceptance Scenarios**:

1. **Given** a season with multiple players, **When** the captain requests per-player aggregates, **Then** each player appears once with total goals, total assists, games played, goals per game, attendance %, weight-loss rate %, and food-tracking rate %.
2. **Given** per-player aggregates, **When** the captain requests them ranked by a metric (e.g. goals), **Then** players are ordered by that metric, highest first.
3. **Given** a player who played zero games in the season, **When** aggregates are computed, **Then** per-game rates are reported as not-applicable (no division-by-zero or misleading rate).
4. **Given** a player resolved by canonical identity, **When** they appear across multiple address forms, **Then** they are counted once (no double-counting).

---

### User Story 3 - Attendance & availability insight (Priority: P3)

As the captain, I want to see attendance/availability figures per player and per fixture, so I can understand turnout and chase up players who rarely show.

**Why this priority**: Valuable but depends on resolving how attendance is defined (see clarifications) and is secondary to the scoring/lifestyle numbers.

**Independent Test**: Seed games with availability poll responses, run the attendance view, and confirm per-player attendance % and average turnout per fixture match the seeded responses.

**Acceptance Scenarios**:

1. **Given** a season with availability polls and responses, **When** the captain requests attendance figures, **Then** each player's attendance % and the squad's average turnout per fixture are shown.
2. **Given** a fixture with no poll or no responses, **When** attendance is computed, **Then** that fixture is excluded from (or clearly marked in) the turnout calculation rather than skewing it.

---

### User Story 4 - Shareable chat report (Priority: P2)

As the captain, I want a single command that prints one paste-ready block combining the team headline numbers and a per-player breakdown, so I can drop the season's stats straight into the WhatsApp group without reformatting.

**Why this priority**: This is the user's explicit "paste into chat" deliverable and the concrete realisation of the reusable calc layer (FR-013). It composes the US1/US2/US3 calculations into one presentation, so it follows them but is high value on its own.

**Independent Test**: Seed a full season (games, stat records, poll responses), run `stats --report` for that season, and confirm the output is a single contiguous text block whose team figures and per-player breakdown match an independent hand calculation, with nothing that requires reflowing to paste into a chat app.

**Acceptance Scenarios**:

1. **Given** a season with games, stats, and poll responses, **When** the captain runs the report, **Then** a single text block is printed in one invocation containing the team section (average attendance per game, total goals, total assists, average goals per game, average assists per game, average weight-loss % per week, average food-tracking % per week) and a per-player breakdown (average goals per attended game, average assists per attended game, food-tracking % of attended games, weight-loss % of attended games).
2. **Given** the report output, **When** the captain pastes it into a chat app, **Then** it remains readable as a single message — no pager, no fixed-width columns or ANSI control codes that depend on a terminal.
3. **Given** the `--json` flag, **When** the captain runs the report, **Then** the same team and per-player figures are emitted as structured JSON.
4. **Given** a season with no qualifying data, **When** the report is run, **Then** it reports "no data" rather than printing an empty or misleading block.

---

### Edge Cases

- **Empty season / no games**: a season with no games or no recorded stats reports "no data" cleanly (exit code distinguishes empty from error).
- **Division by zero**: players or seasons with zero qualifying games show per-game rates as not-applicable, never an error or `NaN`.
- **Cancelled & upcoming games**: aggregates over scoring/per-game rates count only completed games; cancelled and upcoming fixtures are excluded from rate denominators (but games-played-by-status may report them).
- **Partial / unknown lifestyle data**: lifestyle rates use the **attended-games** denominator (FR-008/FR-010). An attended game whose stat report has `weightDirection = unknown`/missing counts as a non-`down` game; an attended game with no stat record or a null/false `foodTracking` is treated as not tracked (`false`, the same default as `goals = 0`) and counts as a non-tracked game. Neither is excluded — both lower the rate rather than being dropped.
- **Player with activity but no stat line for some games**: a completed game the player was available/yes for counts as a played game with 0 goals/0 assists even when no stat record exists; a game the player did not respond "available/yes" to is not counted in their per-game denominator at all.
- **Invalid / non-existent season selector**: reports not-found cleanly.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST extend the existing `stats` command with new flags/modes (team summary, per-player aggregates, attendance) that produce a season-wide team summary for a specified season, including total goals, total assists, games played, and goals per completed game. The new modes MUST reuse the existing `stats` season-selector and `--json` plumbing.
- **FR-002**: The system MUST compute these aggregates from already-captured data (games, stat records, availability poll responses) without requiring any new manual data entry.
- **FR-003**: The system MUST support producing aggregates for any season the team has data for, including past (non-current) seasons, not only the current season.
- **FR-004**: The system MUST provide per-player season aggregates: total goals, total assists, total goal contributions, games played, goals per game, assists per game, attendance %, weight-loss rate %, and food-tracking rate %.
- **FR-005**: The system MUST count each player exactly once per aggregate by resolving to canonical identity, so a player appearing under multiple address forms is not double-counted.
- **FR-006**: The system MUST allow per-player aggregates to be ranked/ordered by a chosen metric (at minimum: goals), highest first, to support leaderboards.
- **FR-007**: The system MUST compute per-game rates over the player's **games played**, defined as completed games for which the player responded "available/yes" to the availability poll. A poll-attended completed game with no stat record counts as a 0-goal/0-assist game in the denominator (not excluded). The system MUST report a rate as not-applicable (rather than zero or an error) when the denominator is zero. (Squad-level goals-per-game in the team summary uses all completed games as its denominator, per FR-001.)
- **FR-008**: The system MUST define a player's **weight-loss rate** as the percentage of that player's **attended games** (completed games they responded "available/yes" to, per FR-007) in which weight was reported as `down` — i.e. `(attended games with weightDirection=down) ÷ (attended games)`. An attended game with `up`, `same`, `unknown`, or no weight direction counts toward the denominator as a non-`down` game (none are excluded). The **squad weight-loss rate** in the team summary MUST be the mean of the per-player weight-loss rates (each player weighted equally, attended players only), not a pooled count. (The data model stores only a per-game weight direction — up/down/same/unknown — not numeric weight, so this is a frequency-of-decrease metric, not a body-mass percentage.)
- **FR-009**: The system MUST derive **attendance** from availability poll responses: a player is counted as attending a fixture when they responded to that fixture's availability poll with the "available/yes" option (intent to attend). Attendance % is that count over the player's **eligible fixtures**, defined as completed games in the season that had an availability poll (fixtures with no poll are excluded from the denominator, per FR-015). (This measures stated availability, not confirmed turnout; presence of a stat record is not used as the attendance signal.)
- **FR-010**: The system MUST define a player's **food-tracking rate** as `(attended games with food tracked) ÷ (attended games)`, using the same "attended games" denominator as FR-007/FR-008. Missing food-tracking data — an attended game with no stat record, or a stat record whose `foodTracking` is null — MUST be treated as **not tracked (`false`)**, the same default rule as `goals = 0`; such a game counts toward the denominator as a non-tracked game (no exclusions). The **squad food-tracking rate** MUST be the mean of the per-player rates (attended players only). (This supersedes the earlier null-exclusion rule: lifestyle rates use the attended-games denominator, not a reports-with-data denominator.)
- **FR-011**: The system MUST report "no data" distinctly from an error when a valid season has no qualifying records, and MUST report "not found" when the requested season does not exist.
- **FR-012**: The system MUST offer both human-readable and JSON output for every aggregate view, consistent with the existing `stats` command and the project's CLI conventions.
- **FR-013**: The aggregation logic MUST be implemented so it can be reused by surfaces other than the CLI (e.g. a future WhatsApp summary) without re-deriving the calculations — i.e. the computation is separable from its CLI presentation.
- **FR-014**: The system MUST report a season's games-played broken down by status (completed / cancelled / upcoming) in the team summary.
- **FR-015**: The attendance/availability view MUST exclude fixtures that have no availability poll from the turnout denominator (or clearly mark them) so they do not skew turnout figures.
- **FR-016**: The system MUST provide a single-output **report** mode of the `stats` command (e.g. `stats --report`) that, in one invocation, prints one contiguous block combining the team section and the per-player breakdown. The human-readable form MUST be plain text safe to paste into a chat app (WhatsApp) — no interactive pager, no fixed-width column layout or ANSI control codes that depend on a terminal — and a `--json` form MUST emit the same figures as structured data.
- **FR-017**: The report's **team section** MUST include, computed over attended players only: average attendance per completed game, total goals, total assists, average goals per completed game, average assists per completed game, average weight-loss % per week, and average food-tracking % per week. "Per week" is the squad-level rate across attended games (mean of the per-player attended-game rates), reflecting the ~weekly fixture cadence.
- **FR-018**: The report's **per-player breakdown** MUST include, for each player (canonical identity, attended players only): average goals per attended game, average assists per attended game, food-tracking % of attended games, and weight-loss % of attended games — using the attended-games denominator defined in FR-007/FR-008/FR-010.

### Key Entities *(include if feature involves data)*

- **Season aggregate**: a derived, read-only roll-up for one season — squad totals (goals, assists), games-played-by-status, squad scoring rate, average turnout, and squad lifestyle rates. Derived from games + stat records + poll responses; not stored.
- **Player aggregate**: a derived, read-only roll-up for one player within a season (all-time scope deferred to a later iteration) — totals, per-game rates, attendance %, weight-loss rate %, food-tracking rate %, keyed by canonical identity.
- **Game** (existing): provides season membership, status, and date; the per-game denominators come from completed games.
- **Stat record** (existing): the per-player-per-game source for goals, assists, weight direction, and food tracking.
- **Availability poll response** (existing): the per-player-per-game source for attendance/availability.
- **Chat report**: a derived, read-only single-block presentation for one season that composes the season aggregate (team section) and the player aggregates (per-player breakdown) into one paste-ready output; not stored, no new data, attended players only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The captain can obtain a full season team summary with a single command, with no manual calculation.
- **SC-002**: For any seeded season, every reported aggregate (totals, per-game rates, attendance %, lifestyle rates) matches an independent hand calculation of the seeded data exactly.
- **SC-003**: Aggregates are available for 100% of seasons that have captured data, including historical seasons.
- **SC-004**: No aggregate view ever emits an error, `NaN`, or a misleading value when a season or player has zero qualifying games — these cases are reported as "no data" or "not applicable".
- **SC-005**: Every aggregate view supports both human-readable and JSON output.
- **SC-006**: Players are counted once each regardless of how many address forms they appear under (zero double-counting across canonical identities).
- **SC-007**: The captain can produce, in a single command, one paste-ready text block containing both the team headline stats and a per-player breakdown, with no manual reformatting needed to share it in a chat app.

## Assumptions

- **Single team**: like the existing `stats` command, aggregates are scoped to the single operator team (`teamId = 1`) in this delivery.
- **Read-only / derived**: aggregates are computed on demand from existing tables; this feature introduces no new captured data and no new write paths.
- **CLI-first**: the only delivery surface in this version is the CLI; the calculation layer is built to be reusable elsewhere later (FR-013), but no other surface is in scope now.
- **Season-only in v1**: per-player and team aggregates are scoped to a single season; an all-time scope is deferred to a later iteration (the calc layer remains reusable per FR-013 so it can be added without rework).
- **Scope of metrics**: the headline metrics the user named (total goals, goals per game, weight-loss %, attendance %) are mandatory; the broader set identified from the data model (assists rates, leaderboards, squad size, turnout) are included where they reuse the same data cheaply.
- **Weight is directional, not numeric**: the data model captures only a weight *direction* per game, so "weight-loss %" is the frequency at which weight was reported `down` over a player's **attended games** (FR-008), not a body-mass percentage. Attended games without a `down` direction (`up`/`same`/`unknown`/missing) count against the player; the squad figure is the mean of per-player rates.
- **Attended-games denominator is uniform**: per-player goals/assists-per-game, weight-loss %, and food-tracking % all share one denominator — the player's attended games (completed + responded "available/yes"). This keeps every per-player rate comparable and matches the chat report's "of attended games" framing.
- **Attendance = stated availability**: attendance is derived from availability poll responses ("available/yes"), measuring intent rather than confirmed turnout (FR-009).
- **Completed games define rates**: only `status = completed` games contribute to per-game rate denominators.
