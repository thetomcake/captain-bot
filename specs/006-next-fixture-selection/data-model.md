# Phase 1 Data Model: Correct Next-Fixture Selection

**No database schema change. No migration.** This feature reuses the existing `seasons` and `games`
tables (features 003/005) exactly as-is. The changes are to **in-memory transformation shapes** and
to **which data is loaded and how it is interpreted**.

---

## Persisted entities (unchanged)

### `seasons` (reused verbatim — FR-010)

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `team_id` | int FK→teams | |
| `season_number` | int | unique per team |
| `start_date` | timestamp \| null | set from earliest stored fixture |
| `end_date` | timestamp \| null | set by `endSeason()` (FR-010) |
| `is_current` | bool | exactly one current per team |

Operations reused unchanged: `getOrCreateCurrentSeason` (lazy creation of next season — FR-012),
`endSeason` (manual rollover — FR-010), season numbering. **Retired from the live path**:
`shouldCreateNewSeason` / auto-`createNewSeason` (FR-011).

### `games` (reused verbatim — FR-007)

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `season_id` | int FK→seasons | |
| `game_date` | timestamp | date **+ kickoff time**; basis for future-date guard (FR-004/FR-008) |
| `opponent` | text | now the **derived** opponent (the non-`TEAM_NAME` side — FR-003) |
| `venue` | text | unchanged constant (FR-006) |
| `status` | `'upcoming' \| 'completed' \| 'cancelled'` | `upcoming` ⇔ unplayed (`-`); `completed` ⇔ both scores numeric |

Our team's fixtures — including already-played ones — continue to be stored across the season
(FR-007), so stat capture (most-recent played game) and historical views keep working. Persistence
is **not** reduced to a single row.

**State interpretation (the corrected part):**
- *unplayed* ⇔ `status = 'upcoming'` (scraper assigns `completed` only when both scores are numeric).
- *next fixture* ⇔ soonest `upcoming` game with `game_date >= now` (existing
  `getUpcomingFixtures` query; first by ascending `game_date`).

---

## In-memory shapes

### `Fixture` (scraper output — `src/scraping/fixture-scraper.ts`)

Existing fields retained: `date`, `time`, `opponent`, `venue`, `status`, `homeTeam?`, `awayTeam?`,
`homeScore?`, `awayScore?`.

**Change**: the parser must surface enough to let the normaliser assign the correct year — i.e. the
week's **month + day** rather than a year already guessed from the current month. The faithful
home/away team names and `-`/numeric scores it already extracts are kept; what is dropped is the
per-fixture year inference inside `extractDate`.

### `OurFixture` (normaliser output — `src/scraping/fixture-normaliser.ts`, NEW)

A league fixture, restricted to those featuring `TEAM_NAME`, with the boundary-correct year and the
derived opponent:

| Field | Derivation |
|-------|-----------|
| `date` (ISO `YYYY-MM-DD`) | week month/day + year assigned from page order anchored to today (FR-002) |
| `time` (`HH:MM`) | from row, unchanged |
| `opponent` | the side that is **not** `TEAM_NAME` (FR-003) |
| `venue` | existing constant (FR-006) |
| `status` | `upcoming` if either score is `-`, else `completed` |

**Selection rule** (FR-004/FR-008), applied after persistence via `getUpcomingFixtures`: the soonest
`OurFixture`/game that is both *unplayed* and *in the future (kickoff ≥ now)*.

---

## Matching & derivation rules

- **Team-name match (FR-001/FR-005)**: `normalise(x) = x.trim().replace(/\s+/g, ' ').toLowerCase()`;
  a side matches when `normalise(side) === normalise(TEAM_NAME)`. A fixture is *ours* iff either
  side matches. If ≥1 league fixture was scraped but none match → log a likely-mismatch entry
  (counts/names only — Principle IV) and yield "no confirmed next fixture".
- **Opponent (FR-003)**: `opponent = homeMatches ? awayTeam : homeTeam`.
- **Year assignment (FR-002)**: walk weeks in page order; anchor the year to today; increment the
  year whenever a week's month is lower than the previous week's month (chronological wrap).

---

## Relationships (unchanged)

`teams 1—* seasons 1—* games 1—0..1 polls 1—* poll_responses`; `games 1—* stat_records`. This feature
touches none of these relationships — only the values written into `games.opponent`/`game_date` (now
correct) and the season-boundary trigger (now manual).
