# Contract: `captain-stats end-of-season` CLI command

Manual season rollover (FR-010/FR-012/FR-013, US4). Replaces the retired automatic detector
(FR-011). Reuses `SeasonService.endSeason` and `getOrCreateCurrentSeason` unchanged.

## Synopsis

```
captain-stats end-of-season [--yes | --force] [--json] [--config <path>]
```

## Options

| Flag | Effect |
|------|--------|
| `--yes`, `--force` | Skip the interactive confirmation (non-interactive/scripted use). |
| `--json` | Machine-readable result on stdout. |
| `--config <path>` | **Inherited global flag** (not introduced by this feature). Path to the `.env` config file (`TEAM_NAME`, `CLUB_URL`, `DATABASE_PATH`, …), parsed in `src/cli/index.ts` for every command; defaults to `.env` in cwd. Listed only because `end-of-season` inherits it like all subcommands — no new requirement. |

## Behaviour

1. Resolve the current season for the team (single-operator `teamId = 1`).
2. **No current season** → report "no active season to end", make **no changes**, exit `0`. A second
   invocation before any new fetch is therefore a safe no-op (FR-013, US4 AS5/AS6).
3. **Current season exists**:
   - Display the `season_number` about to end.
   - **Without `--yes`/`--force`**: prompt for confirmation (default No). Declining makes no changes
     and exits `0` (US4 AS3). Confirming proceeds.
   - **With `--yes`/`--force`**: proceed without prompting (US4 AS4).
   - On proceed: call `endSeason(season.id)` → `is_current = false`, `end_date = now`; all games/stats
     of that season preserved unchanged (US4 AS1).
4. The command does **not** create the next season; the next fixture fetch lazily creates it via
   `getOrCreateCurrentSeason` and stores new fixtures there, leaving the previous season untouched
   (FR-012, US4 AS2).

## Output

- Human: e.g. `✓ Season 3 ended (2026-06-17). Next fetch will start season 4.` / `No active season to
  end.` / `Cancelled — season 3 left unchanged.`
- `--json`: `{ "ended": true, "seasonNumber": 3, "endDate": "..." }`, or
  `{ "ended": false, "reason": "no-current-season" }`, or `{ "ended": false, "reason": "cancelled" }`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Season ended, OR no current season (no-op), OR user declined |
| `1` | Unexpected runtime/DB error |

## Testability

The confirmation prompt is provided via an **injectable** dependency (`deps.confirm?: () =>
Promise<boolean>`), defaulting to a stdin y/N read. Tests inject a fake confirm (true/false) and
assert season state + output without a TTY (constitution II). The `--yes`/`--force` path bypasses
`confirm` entirely.

## Acceptance mapping

| Scenario | Covered |
|----------|---------|
| US4 AS1 (end + preserve games/stats) | step 3 `endSeason` |
| US4 AS2 (lazy next season on next fetch) | step 4 + `getOrCreateCurrentSeason` |
| US4 AS3 (prompt, decline = no change) | step 3 confirm=false |
| US4 AS4 (`--yes`/`--force` skips prompt) | step 3 flag |
| US4 AS5 (no current season) | step 2 |
| US4 AS6 (no auto-transition) | FR-011 retirement (see fixture-selection contract / research §6) |
