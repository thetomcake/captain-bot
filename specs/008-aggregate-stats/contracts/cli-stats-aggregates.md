# Contract: `stats` aggregate & report views

Per clarification Q1, the season roll-ups are **new flags on the existing `stats` command** — not a
new verb. Read-only; computed from existing data. Reuses the `stats` season-selector and `--json`
conventions (stdout for data, stderr for human errors).

## Synopsis

```text
# Existing raw views (UNCHANGED):
captain-stats stats --game <id> [--json]
captain-stats stats --season <n> [--json]

# New aggregate views (this feature):
captain-stats stats --summary    [--season <n>] [--json]
captain-stats stats --players    [--season <n>] [--rank <metric>] [--json]
captain-stats stats --attendance [--season <n>] [--json]
captain-stats stats --report     [--season <n>] [--json]
```

## Views

| Flag | View | Story | Output shape |
|------|------|-------|--------------|
| `--summary` | Team season summary | US1 | `SeasonAggregate` |
| `--players` | Per-player aggregates + leaderboard | US2 | `PlayerAggregate[]` |
| `--attendance` | Attendance / turnout | US3 | `AttendanceReport` |
| `--report` | Single paste-into-WhatsApp block | US4 | `{ season, players }` |

The four aggregate flags are mutually exclusive with each other and with `--game`. Supplying more
than one, or combining an aggregate flag with `--game`, is a usage error (exit 2). When no aggregate
flag is given, the command behaves exactly as before (`--game`/`--season` raw line views).

## Options

| Option | Applies to | Default | Meaning |
|--------|-----------|---------|---------|
| `--season <n>` | all aggregate views | current season | Select the season by its number. Past seasons fully supported (FR-003). Season-only — there is no all-time scope in v1 (Q4). |
| `--rank <metric>` | `--players` | `goals` | Order players by a metric, highest first (FR-006). One of: `goals`, `assists`, `contributions`, `attendance`, `weightloss`, `foodtracking`. |
| `--json` | all views | off | Emit the view as structured JSON instead of human output (FR-012). |
| `--help` | — | — | Print usage (now listing the aggregate flags) and exit 0. |

## Exit codes

| Code | Condition | Requirement |
|------|-----------|-------------|
| `0` | Success — aggregates printed. | — |
| `1` | Requested `--season <n>` does not exist for the team ("not found"). | FR-011 |
| `2` | Valid season but no qualifying data ("no data"), **or** a usage error (unknown `--rank` metric; >1 aggregate view flag; an aggregate flag with `--game`). The message disambiguates. | FR-011, Edge Cases |
| `3` | Unexpected error (caught exception — matches the existing `stats` catch). | — |

"No data" (2) is distinct from "error" (3) per the Edge Cases ("exit code distinguishes empty from
error"), and carries a different message from "not found" (1) per FR-011.

## Output — human-readable

### `--summary` (US1) — example, illustrative

```text
Season 2 — Team Summary

Games:         8 completed, 1 cancelled, 2 upcoming
Goals:         34 (4.25 per completed game)
Assists:       19 (2.38 per completed game)
Squad size:    12 players
Avg turnout:   7.4 per fixture
Weight-loss:   61%  (squad avg of per-player rates)
Food tracking: 78%  (squad avg of per-player rates)
```

### `--players --rank goals` (US2) — terminal table (alignment OK here)

```text
Season 2 — Players (ranked by goals)

Player            G   A   GC  Att  G/Att  A/Att  Att%   WL%   Food%
Alice            12   4   16    8   1.50   0.50   88%   38%    75%
Bob               9   7   16    7   1.29   1.00   75%   n/a    60%
...
```

`G`/`A` are totals over attended games; `Att` = attended games; `G/Att`,`A/Att` are per-attended-game
rates; `Att%`,`WL%`,`Food%` are the attendance/weight-loss/food-tracking rates. A `null` rate prints
as `n/a` (never `0`, never `NaN` — SC-004).

### `--attendance` (US3) — example

```text
Season 2 — Attendance   (avg turnout 7.4 per fixture)

Player            Attended/Eligible   Att%
Alice                       7/8        88%
Bob                         6/8        75%
...
```

### `--report` (US4) — single chat-safe block (FR-016)

**No fixed-width columns, box-drawing, ANSI, or pager** — WhatsApp uses a proportional font, so the
report is plain `Label: value` lines plus one line per player. Illustrative:

```text
Season 2 — Team Report

Avg attendance/game: 7.4
Goals: 34  (avg 4.25/game)
Assists: 19  (avg 2.38/game)
Avg weight-loss/week: 61%
Avg food-tracking/week: 78%

Players (attended players only):
- Alice — 1.50 goals, 0.50 assists per game · food 75% · weight-loss 38%
- Bob — 1.29 goals, 1.00 assists per game · food 60% · weight-loss n/a
...
```

The whole report is printed in one invocation to stdout so it can be copied as a single message.

### Error / empty (human)

No data → `No data for season <n>` to stderr, exit 2. Not found → `Season <n> not found` to stderr,
exit 1. Usage error → a usage message to stderr, exit 2.

## Output — JSON (`--json`)

A single JSON object on stdout; rates are `number` or `null` (never `NaN`). Shapes match
`data-model.md`:

- `--summary` → `SeasonAggregate`.
- `--players` → `{ season, rankBy, players: PlayerAggregate[] }`.
- `--attendance` → `AttendanceReport`.
- `--report` → `{ season: SeasonAggregate, players: PlayerAggregate[] }`.

For not-found / no-data / usage errors in `--json` mode, emit `{ "error": "..." }` (matching the
existing `stats` JSON error convention) with the same exit code as the human path.

## Invariants

- Read-only: the command never writes to the database or WhatsApp.
- Every numeric rate is `number | null`; no view emits `NaN`, `Infinity`, an error, or a misleading
  `0` for an empty denominator (SC-004).
- Each player appears at most once per view, keyed by canonical identity (FR-005/SC-006).
- Works for any season with data, including non-current seasons (FR-003/SC-003).
- The legacy `--game` / `--season` raw views are byte-for-byte unchanged.
- `--report` human output contains no tab, box-drawing, or ANSI escape characters (FR-016).
