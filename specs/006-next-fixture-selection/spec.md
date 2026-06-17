# Feature Specification: Correct Next-Fixture Selection for Our Team

**Feature Branch**: `006-next-fixture-selection`

**Created**: 2026-06-17

**Status**: Draft

**Input**: User description: "I have noticed a bug, when sending out the poll for the next game it can get the incorrect game. The Team name as specified in config is say 'White Team' [...]. We are the white team, we may be home or away, the fixtures loaded are for the whole league, not just for our team. We only want to post a poll for our next game, be we home or away [...]. Some additional changes to behaviour: [year-boundary concern → identify the next fixture by the unplayed '-' score + future date + TEAM_NAME, allowing for the up-to-5-day score-update lag]; and filter loaded fixtures to only our configured team."

## Context & Problem *(informative)*

This feature is a **behaviour-change extension of the MVP (feature `003-mvp-attempt-2`)**. It corrects how the system identifies "our team's next fixture" — the fixture an availability poll is posted for — and how it loads fixtures from the club website.

The MAN v FAT club fixtures page lists the fixtures for the **whole league** (every team in the club's division), grouped into weeks. Each fixture row names a home team and an away team, and shows a score for each side; an **unplayed** fixture shows `-` for both scores, while a **played** fixture shows numbers. Our team is identified by the configured `TEAM_NAME`, and in any given week we may be the **home** team or the **away** team — but we always play at the same place, so being home or away makes no difference to where the team turns up.

Three defects/limitations exist in the current behaviour:

1. **Wrong game can be selected for the poll.** The system picks the earliest upcoming fixture across the *whole league*, not our team's next game. It also always assumes we are the away side and labels the home side as the opponent. As a result the poll can be posted for a game our team is not even playing in, with the wrong opponent.

2. **Year-boundary mis-ordering.** The system infers each fixture's calendar year from its month relative to "today". Near a year boundary this is wrong: if today is 20 December, a fixture dated "December 29th" is correctly this year, but the following "January 4th" fixture is next year — yet the current inference can treat January as the *current* year and therefore as already past, so it is mis-ordered or skipped. Rather than refine year-guessing, the system should identify the next fixture from the fact that it is **unplayed** (score `-`), **in the future**, and **for `TEAM_NAME`**.

3. **No team filtering on load.** Fixtures for every league team are loaded and stored, when only our team's fixtures are relevant.

A known edge: the club site can take **up to 5 days** to publish a played game's score, so a fixture our team has **already played** may still show `-`. The unplayed marker alone therefore cannot mean "upcoming"; it must be combined with the fixture being in the future.

**Additional scope — manual season rollover.** Because this feature stops loading the whole-league/all-fixtures set (FR-001) and identifies the next game from the unplayed-marker heuristic rather than the full scraped schedule, the signal that the MVP's **automatic** season-transition detector (feature `003-mvp-attempt-2`, FR-005 / US5 — `shouldCreateNewSeason`) relied on ("every previously-scraped upcoming fixture has disappeared") is no longer reliable. Rather than re-engineer that calculation, this feature **retires the automatic detector and replaces it with a manual CLI `end-of-season` command** (US4). The underlying season data model is **unchanged from 003** — the `seasons` table (`season_number`, `is_current`, `start_date`, `end_date`) and the `SeasonService` operations (`endSeason`, `getOrCreateCurrentSeason`) are reused as-is; only the *trigger* for a season boundary moves from automatic to manual.

> **Out of scope / unchanged:** The poll's wording, options, and venue text MUST NOT change based on whether we are home or away (we always play at the same place — FR-006). The poll-posting trigger (`!postpoll` / `poll` CLI), poll replacement, vote tallying, stat capture, and historical views are all unchanged except where they consume the corrected fixture data. Fixtures continue to be **stored** for our team across the season (this feature does not reduce persistence to a single row — recently-played games and history remain available for stat capture and historical views); only *which* fixtures are loaded (ours, not the league's), *which one* is chosen as "next", and *how a season boundary is triggered* (manual command instead of automatic detection) change.

## Glossary

- **`TEAM_NAME`**: the configured name of our team (e.g. "White Team"), set in config. The spec never names a specific team — all behaviour is relative to the configured value.
- **Our fixture**: a league fixture in which `TEAM_NAME` is either the home team or the away team.
- **Opponent**: in one of our fixtures, the team that is *not* `TEAM_NAME` (the other side), regardless of whether we are home or away.
- **Unplayed marker**: the `-` shown in place of a numeric score for a fixture whose result has not been published.
- **Next fixture**: our team's soonest fixture that is still to be played — i.e. unplayed and kicking off in the future.

## Clarifications

### Session 2026-06-17

- Q: Does the manual `end-of-season` command replace the existing automatic season-transition detection (003 FR-005 / `shouldCreateNewSeason`), or run alongside it? → A: Replace — automatic detection is retired; seasons roll over only via the manual command.
- Q: When `end-of-season` runs, what happens to the next season? → A: End the current season only; season N+1 is created lazily on the next fixture fetch via the existing `getOrCreateCurrentSeason` (no empty placeholder created up front).
- Q: Should `end-of-season` require confirmation? → A: Confirm by default (prompt naming the season being ended), with a `--yes`/`--force` flag to skip the prompt for non-interactive use.
- Q: How are the date-relative cases (year-boundary, score-lag) made testable — generate HTML, or fake the clock? → A: Fake the clock. Tests use **static/representative league HTML** plus an **injectable "now"/"today"** (deterministic clock) threaded through the normaliser (year assignment) and the selection guard. Dynamically generating HTML is rejected as overkill — week headers carry no year and "past/future" is purely relative to "now", so controlling the clock against fixed-date fixtures is sufficient.
- Q: Should implementation read configuration via direct `process.env` or the loaded config? → A: Via the loaded configuration object (`getEnv()` / `EnvironmentConfig`) wherever possible, not direct `process.env` reads — the config loader stays the single source of truth for settings.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Poll targets our team's next game (Priority: P1)

As a team member, when I trigger an availability poll, I need it posted for **our team's** next game — whether we are home or away — so the poll always concerns a game we are actually playing, against the correct opponent.

**Why this priority**: This is the reported defect. A poll posted for the wrong game (a fixture our team is not in, or the wrong opponent) actively misleads the team about availability and is worse than no poll.

**Independent Test**: Provide a league fixture list (via the fixture-scraper boundary) in which our team's next game is *not* the earliest league fixture and in which our team is the **away** side in one upcoming game and the **home** side in another. Trigger the poll and verify it targets our team's soonest unplayed future game, with the opponent set to the other side.

**Acceptance Scenarios**:

1. **Given** the league fixture list contains upcoming games for several teams and our team's next game is not the chronologically-earliest league game, **When** a poll is triggered, **Then** the poll is posted for our team's next game (not the earliest league game).
2. **Given** our team is the **home** side in its next game, **When** a poll is triggered, **Then** the poll is posted for that game and the opponent is the **away** side.
3. **Given** our team is the **away** side in its next game, **When** a poll is triggered, **Then** the poll is posted for that game and the opponent is the **home** side.
4. **Given** the loaded fixtures contain no games featuring `TEAM_NAME` (e.g. off-season for us, or a `TEAM_NAME` that does not match the site's spelling), **When** a poll is triggered, **Then** no poll is posted, the existing "no confirmed next fixture" behaviour applies, and the system logs that league fixtures were present but none matched our team (a likely `TEAM_NAME` mismatch).

---

### User Story 2 - Next fixture identified correctly across the year boundary (Priority: P2)

As a team member triggering a poll near the New Year, I need the system to pick the genuinely-next game even when our season spans 31 December → 1 January, so a January fixture is never mistaken for a past game.

**Why this priority**: Without this, polls near the year boundary silently target the wrong game or report "no fixture" when one exists — a recurring seasonal failure that is hard to notice until the poll is already wrong.

**Independent Test**: With "today" set to late December, provide our team's fixtures spanning into January, all unplayed (`-`). Verify the January fixture is recognised as a future game and selected as next (not treated as past).

**Acceptance Scenarios**:

1. **Given** today is in late December and our team has an unplayed fixture later in December and a further unplayed fixture in early January, **When** the next fixture is resolved, **Then** the late-December fixture is selected as next and the January fixture is recognised as a later future fixture (not as a past game).
2. **Given** the late-December fixture has now been played (and shows a score) while the January fixture is still unplayed, **When** the next fixture is resolved, **Then** the January fixture is selected as next.
3. **Given** our team's fixtures span the year boundary, **When** fixtures are loaded, **Then** each is assigned the correct calendar year so that chronological ordering is correct across 31 December → 1 January.

---

### User Story 3 - Recently-played game with a pending score is not chosen (Priority: P3)

As a team member, I need a game we have **already played** but whose score has not yet appeared on the site (still showing `-`) to be excluded from selection, so the poll is never posted for a game in the past.

**Why this priority**: The site's up-to-5-day score-publishing lag means the unplayed marker is not by itself proof of an upcoming game; without this guard, the poll could target a game already played.

**Independent Test**: Provide our team's fixtures where the most recent game is in the past but still shows `-` (score not yet published) and a later game is genuinely upcoming. Verify the past game is not selected and the genuinely-upcoming game is.

**Acceptance Scenarios**:

1. **Given** our team's most recent fixture is in the past but still shows `-`, and a later unplayed fixture is in the future, **When** the next fixture is resolved, **Then** the future fixture is selected and the past `-` fixture is ignored.
2. **Given** our team's only `-` fixture is in the past (no future fixture exists yet), **When** the next fixture is resolved, **Then** no next fixture is found and the existing "no confirmed next fixture" behaviour applies.
3. **Given** our team's next fixture is later **today** but has not yet kicked off, **When** the next fixture is resolved, **Then** it is treated as upcoming and selected.

---

### User Story 4 - Manually roll over to a new season (Priority: P2)

As a team captain, I need a manual CLI command to declare the current season over, so that the next fixtures we fetch start a fresh season — because the automatic season detection is no longer reliable once we stop loading the whole-league schedule, and I am the one who actually knows when the season has ended.

**Why this priority**: This feature retires the MVP's automatic season-transition detection (003 FR-005). Without a replacement, seasons would never roll over and a new season's fixtures would be mixed into the previous season, corrupting historical stats and views. The manual command is the sole season-boundary mechanism, so it is required alongside the next-fixture fix.

**Independent Test**: With a current season holding games, run `end-of-season` (confirming the prompt), verify the current season is marked ended and preserved, then fetch fixtures and verify the newly-fetched games land in a new season (next season number) with the previous season's data intact.

**Acceptance Scenarios**:

1. **Given** a current season exists with stored games, **When** I run `end-of-season` and confirm, **Then** that season is marked no longer current with an end date set, and all its games/stats are preserved unchanged.
2. **Given** the current season has just been ended, **When** fixtures are next fetched (`sync`/`fixtures`/`!postpoll`), **Then** a new current season (the next season number) is created and the newly-fetched fixtures are stored in it, leaving the previous season untouched.
3. **Given** I run `end-of-season` without `--yes`/`--force`, **When** the command starts, **Then** it shows the season number it is about to end and waits for confirmation; declining makes no changes.
4. **Given** I run `end-of-season --yes` (or `--force`), **When** the command runs, **Then** it ends the current season without an interactive prompt (for non-interactive/scripted use).
5. **Given** there is no current season to end, **When** I run `end-of-season`, **Then** the command reports that there is no active season to end and makes no changes (no crash).
6. **Given** the season has already been rolled over (automatic detection is gone), **When** fixtures continue to be fetched within the same season, **Then** no season transition occurs automatically — only `end-of-season` starts a new season.

---

### Edge Cases

- **Whole-league list, our team absent**: the scrape returns league fixtures but none feature `TEAM_NAME` → treat as "no confirmed next fixture" and log a likely `TEAM_NAME` mismatch (FR-005, US1 scenario 4).
- **`TEAM_NAME` spelling/casing differs from the site**: matching is done in a normalised, case-insensitive way (FR-001); a genuine mismatch surfaces as "no fixtures matched our team" rather than a crash.
- **Both scores still `-` for a future game**: this is the normal upcoming-fixture case and is selectable (FR-003/FR-004).
- **Past game still `-` (score lag)**: excluded by the future-date condition (FR-008 / US3).
- **Year boundary (Dec → Jan)**: handled by deriving each fixture's year from the season's chronological ordering anchored to today, so January after December rolls to the next year (FR-002 / US2).
- **"Fixtures to be confirmed" placeholder rows**: continue to be skipped (unchanged from MVP); an unconfirmed slot yields no postable next fixture.
- **Club site unreachable / scrape fails**: unchanged from MVP — no poll is posted and the existing fetch-failure behaviour applies.
- **Poll wording when home vs away**: identical in both cases — the home/away distinction never alters the poll text or venue (FR-006).
- **Downstream consumers**: stat capture (most-recent played game) and historical fixture/stat views continue to work because our team's fixtures — including played ones — remain stored (FR-007).
- **`end-of-season` with no current season**: the command reports there is nothing to end and makes no changes (FR-013 / US4 scenario 5).
- **`end-of-season` run twice**: after the first run ends the current season, a second run before any new fixtures are fetched finds no current season and is a safe no-op with a clear message (FR-013).
- **Automatic season transition removed**: continued fixture fetches within a season never trigger a new season on their own; only `end-of-season` does (FR-011 / US4 scenario 6).
- **Fetching after `end-of-season`**: the next fixture fetch lazily creates the new current season and stores the new fixtures there; previous-season data is untouched (FR-012 / US4 scenario 2).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When loading fixtures from the club website, the system MUST keep only **our fixtures** — those in which `TEAM_NAME` is the home or the away team — and discard fixtures between two other league teams. Matching `TEAM_NAME` against the site's team names MUST be whitespace-normalised and case-insensitive.
- **FR-002**: The system MUST assign each loaded fixture the correct calendar year so that fixtures order correctly across a year boundary (e.g. a January fixture following a December fixture is treated as the next year, not the current one). Year assignment MUST NOT rely on guessing each fixture's year independently from its month.
- **FR-003**: For each of our fixtures, the system MUST derive the **opponent** as the team that is not `TEAM_NAME` (the other side), whether we are home or away.
- **FR-004**: The system MUST identify the **next fixture** as our team's soonest fixture that is BOTH (a) **unplayed** (shown with the `-` score marker) AND (b) **in the future** (kickoff is now or later). A fixture failing either condition MUST NOT be selected as next.
- **FR-005**: When loaded fixtures contain no games featuring `TEAM_NAME`, the system MUST treat this as "no confirmed next fixture" (the existing MVP behaviour: no poll posted, in-chat reply, logged) AND MUST log that league fixtures were present but none matched our team, indicating a likely `TEAM_NAME` mismatch.
- **FR-006**: The poll's question, options, and venue text MUST be identical whether our team is home or away; the home/away distinction MUST NOT change the poll content.
- **FR-007**: The change MUST preserve continued storage of our team's fixtures across the season (including already-played games), so that stat capture (most-recent played game) and historical fixture/stat views keep working. This feature MUST NOT reduce fixture persistence to only the single next fixture.
- **FR-008**: A fixture our team has already played but whose score has not yet been published (still showing `-` due to the up-to-5-day publishing lag) MUST NOT be selected as the next fixture (it fails the future-date condition of FR-004).
- **FR-009**: All existing MVP fixture/poll behaviours not listed above (the `!postpoll` and `poll` triggers, poll replacement and vote-deletion semantics, "Fixtures to be confirmed" skipping, scrape-failure handling, stat capture, historical views) MUST remain unchanged in observable behaviour, consuming the corrected fixture data. (Automatic season-transition detection is the one exception — it is replaced by FR-010–FR-013 below.)
- **FR-010**: The system MUST provide a manual CLI command (`end-of-season`) that ends the current season. Ending a season MUST reuse the existing 003 season data model unchanged — the `seasons` table (`season_number`, `is_current`, `start_date`, `end_date`) and `SeasonService.endSeason` — marking the current season as no longer current and recording its end date, while leaving all of that season's games and stats intact.
- **FR-011**: The system MUST retire the MVP's automatic season-transition detection (003 FR-005 / `shouldCreateNewSeason`): fixture fetches (`sync`, `fixtures`, `!postpoll`) MUST NOT create a new season on their own. A new season MUST begin only as a result of the `end-of-season` command.
- **FR-012**: After `end-of-season` has ended the current season, the next fixture fetch MUST lazily create the new current season (the next season number) via the existing `getOrCreateCurrentSeason` and store newly-fetched fixtures in it, without modifying the previous season's data. No empty placeholder season is created by the command itself.
- **FR-013**: `end-of-season` MUST require confirmation by default — displaying the season number it is about to end and proceeding only on confirmation — and MUST accept a `--yes` (or `--force`) flag that skips the prompt for non-interactive use. When there is no current season to end, the command MUST report this and make no changes (no crash); a second invocation before any new fixtures are fetched is therefore a safe no-op.

### Key Entities *(include if feature involves data)*

- **Fixture (our team's)**: a single league game involving `TEAM_NAME`. Attributes: date, kickoff time, home team, away team, derived opponent (the non-`TEAM_NAME` side), played/unplayed state (from the score marker), and resulting status (upcoming vs completed). Only our fixtures are loaded/stored.
- **Next fixture**: the selected fixture for the availability poll — our soonest fixture that is unplayed and in the future.
- **Season** *(reused from 003, unchanged)*: a numbered competition period for the team (`season_number`, `is_current`, `start_date`, `end_date`), grouping the games/stats captured within it. This feature changes only how a season *ends* (manual `end-of-season` command) and begins (lazily on the next fetch after ending), not the entity's shape or its relationship to games.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of cases where our team's next game is not the earliest league fixture, the poll targets our team's next game (never another team's game).
- **SC-002**: In 100% of our fixtures, the opponent shown is the side our team is not, regardless of whether we are home or away.
- **SC-003**: For season schedules that cross a calendar-year boundary, the next fixture is identified correctly in 100% of cases (a January fixture following a December fixture is never treated as past).
- **SC-004**: A game our team has already played but still showing `-` (score not yet published) is selected as the next fixture 0% of the time.
- **SC-005**: When no loaded fixture features `TEAM_NAME`, the system posts no poll and emits a log entry indicating a likely `TEAM_NAME` mismatch in 100% of such cases.
- **SC-006**: The poll content (question, options, venue text) is identical for home and away fixtures in 100% of cases.
- **SC-007**: All previously-passing MVP fixture, poll, stat-capture, and historical-view behaviours remain green after the change (no regression), with the sole intended change being that season transitions are now manual rather than automatic.
- **SC-008**: After `end-of-season` is run and fixtures are next fetched, 100% of the newly-fetched fixtures are stored under a new season number and 0% of the previous season's games/stats are modified.
- **SC-009**: Fixture fetches (`sync`/`fixtures`/`!postpoll`) trigger a new season 0% of the time (no automatic season transition); a new season begins only via `end-of-season`.
- **SC-010**: Running `end-of-season` when no current season exists makes no changes and does not error in 100% of cases.

## Assumptions

- **Scope of "only load the next fixture"**: interpreted as *load only our team's fixtures (not the whole league) and reliably select the single correct next fixture for the poll* — NOT as reducing database persistence to one row. The code shows stat capture depends on recently-played games being stored, season-transition detection compares the full scraped set, and historical views read all games; storing a single fixture would break these. Our team's fixtures therefore continue to be stored across the season (FR-007).
- **Team matching**: `TEAM_NAME` is matched against the visible team-name text on the fixtures page using whitespace-normalised, case-insensitive equality (the site shows names like "White Team", "Black Team", "yellow team"). An exact normalised match is required; fuzzy/partial matching is out of scope.
- **Page ordering**: the fixtures page lists fixtures grouped into weeks in chronological order; this ordering (anchored to today) is the basis for assigning the correct year across the boundary and for finding the soonest unplayed future fixture. If the site ever published fixtures out of chronological order, that is out of scope.
- **"In the future"** is evaluated against the fixture's kickoff date and time in the configured timezone; a game later today that has not yet kicked off counts as upcoming (US3 scenario 3).
- **Unplayed marker**: a fixture is "unplayed" when its score is shown as `-`; a numeric score means played. This mirrors the existing scraper's interpretation.
- **No poll-message changes**: the existing poll wording/options/venue text from the MVP are reused verbatim; this feature only changes which fixture they describe.
- **No new configuration**: the feature uses the existing `TEAM_NAME` config value; no new settings are introduced. Implementation reads it (and any other settings) through the loaded configuration object (`getEnv()` / `EnvironmentConfig`) wherever possible, rather than via direct `process.env` access — the config loader remains the single source of truth.
- **Season data model reused from 003**: the `end-of-season` command builds on the existing `seasons` table and `SeasonService` (`endSeason`, `getOrCreateCurrentSeason`, season numbering) from feature `003-mvp-attempt-2`; no schema migration or new season fields are introduced. The automatic detector `shouldCreateNewSeason` (003 FR-005 / US5) is retired — superseded here, not extended.
- **Manual rollover cadence**: ending a season is an infrequent, captain-initiated action; there is no scheduling or reminder for it (out of scope). The captain decides when the season is over.
- **Testing**: per the project constitution and `tests/README.md`, behaviour is verified at the fixture-scraper service boundary with **static/representative league HTML**; no live network calls. The year-boundary and score-lag cases are **date-relative**, so they are made deterministic by **faking the clock** — an injectable "now"/"today" is threaded through the normaliser (year assignment) and the selection guard — rather than by generating HTML. Static fixtures (covering home/away variants, a year-boundary span, and a score-lag row) plus a chosen fake "now" are sufficient; dynamic HTML generation is explicitly out of scope as overkill.
