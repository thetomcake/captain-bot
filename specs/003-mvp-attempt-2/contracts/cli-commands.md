# Contract: `captain-stats` CLI command surface

**Feature**: `003-mvp-attempt-2` | **Date**: 2026-06-15

The MVP's user-facing contract (Constitution I — CLI-First). Each command reads args/env, writes
human output to stdout, errors to stderr, and supports `--json` where it aids scripting. Global
flags: `--config|-c <path>`, `--help|-h`, `--version|-v`, `--json`.

| Command | Story | Purpose | Key args | Notes |
|---------|-------|---------|----------|-------|
| `init` | — | Create config + DB, register team/season | `--team-name`, `--club-url` | REUSE |
| `fixtures` | US1 | View fixtures (chronological) | `--all`, `--season <n>`, `--json` | REUSE (review) |
| `sync` | US1/US5 | Manual fixture re-scrape; runs transition detection | `--team-id` | reflects updates (FR-003); may create a new season (FR-005) |
| `stats` | US4 | View stored stats | `--game <id>`, `--season <n>`, `--json` | **NEW** (view-only this MVP) |
| `seasons` | US4/US5 | List season history | `--json` | **NEW** |
| `poll` | US2 | Post availability poll via Gateway | `[game-id]`, `--force`, `--dry-run`, `--json` | REWORK onto port |
| `connect` | US setup | Connect + list groups for `AUTHORIZED_GROUP_ID` | `--reset` | REWRITE on `connect()`+`listGroups()`; MVP renders QR |
| `daemon` | US2/US3/US5 | Long-running monitor | `--foreground|-f`, `--log <path>` | REWORK on Gateway events only (no crons) |

## Exit codes (convention, preserved from current CLI)

`0` success · `1` not-found/empty result · `2` missing/invalid prerequisite (e.g. no team) ·
`3` missing config (e.g. `AUTHORIZED_GROUP_ID` unset) · `4` runtime/connection failure.

## Command behaviour contracts

### `connect` (REWRITE)
1. `gateway.connect()`; on `onQR(value)` render terminal QR **and** save a PNG, print its path
   (FR-007). 2. `listGroups()` → print a table `id  [addressingMode]  name` and the line to set
   `AUTHORIZED_GROUP_ID` (printed only; not persisted — FR-011). 3. Exit `0`. Shares the persisted
   credential snapshot with `daemon` (no second QR scan).

### `poll` (REWORK — admin escape hatch; the in-chat `!postpoll` is the primary path)
- `--dry-run`: re-fetch fixtures, print the next fixture + question/options, send nothing, exit `0`.
- Default: require `AUTHORIZED_GROUP_ID` (else exit `3`); re-fetch fixtures (FR-003); if no confirmed
  next fixture, print why and exit `1`; refuse if a poll exists unless `--force` (FR-027 replacement);
  `sendPoll` → persist keyset + poll row; print the poll ref. Exit `0`/`1`/`3`.

### `!postpoll` (in-chat command — handled by the daemon, NOT a CLI command)
- Any authorized-group message whose whole text equals `!postpoll` (case-insensitive, trimmed) is
  intercepted by the event-router **before** stat extraction (FR-029) and runs the same logic as the
  `poll` command above: re-fetch → post next fixture's poll, or replace an existing one (FR-027).
- **Silent on success** (the posted poll is the confirmation); replies in-chat only on problems —
  no confirmed next fixture, or club-site fetch failure (FR-028). All outcomes logged (FR-025).
- **Anyone** in the group may send it; a re-trigger force-replaces and deletes existing votes
  (accepted footgun, FR-029).

### `daemon` (REWORK — pure event listener, no crons)
- Require `AUTHORIZED_GROUP_ID` (else exit `3`). Build the Gateway via the factory; subscribe
  `onConnectionChange` (log only, FR-010), `onMessage` (route `!postpoll` first, else US3 stat
  capture), `onPollVote` (US2 tally). No scheduled jobs — all poll posting and fixture fetching are
  triggered by `!postpoll`/`poll`/`sync` (FR-003/FR-012/FR-029).
- `SIGINT`/`SIGTERM`: persist credentials via `getCredentials()`, `disconnect()`, exit `0`.

### `stats` (NEW)
- **View only**: `--game <id>` or `--season <n>` → stats grouped by player (canonical identity)
  with goals/assists/weight/food (FR-023). `--json` for machine output. Works for past seasons.

### `seasons` (NEW)
- List all seasons (number, date range, current flag); enables selecting a previous season for
  `fixtures`/`stats` (FR-004, SC-006).

## Output validation (per Constitution II "minimal output validation")
One structural test per output type (human + `--json`); no formatting-regex assertions.
