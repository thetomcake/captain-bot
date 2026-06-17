# Quickstart & Validation: Correct Next-Fixture Selection

Validates the feature end-to-end. Follows `tests/README.md`: service-boundary mocking, real
`scrapeFixtures` over static HTML, in-memory SQLite, no live network. See
[data-model.md](./data-model.md) and [contracts/](./contracts/) for details.

## Prerequisites

```bash
npm install
npm run build        # tsc (NodeNext, strict)
```

## Run the suite

```bash
npm test                     # full suite (must stay green — SC-007, no regression)
npm run test:unit            # normaliser (year/filter/opponent) + service/selection units
npm run test:integration     # league HTML → our-team fixtures; end-of-season; lazy new season
```

## Test HTML — static fixtures + a faked clock

The year-boundary (FR-002) and score-lag (FR-008) cases are **date-relative**, but week headers carry
no year and "past/future" is purely relative to "now" — so a **fake clock** (an injectable
"now"/"today") against **static** HTML fixtures is sufficient. Do **not** generate HTML dynamically
(overkill — see Clarifications). The real `scrapeFixtures` runs over the static HTML via
`MockFixtureScraper`; tests pass a chosen `now` to the normaliser and the selection guard.

Add small static fixtures under `tests/fixtures/html/` (clone/trim the existing
`manvfat-fixtures.html`) covering:
- **Home & away variants**: a week where `TEAM_NAME` is home and another where it is away (FR-003).
- **Our next ≠ earliest league game**: an earlier league fixture between two *other* teams, with our
  team's first game later (FR-001 + US1 AS1).
- **Year-boundary span**: weeks running late-December into early-January, all unplayed; tests set
  `now` to late December (FR-002/US2).
- **Score-lag**: a week dated before `now` still showing `-`, plus a genuine future week; tests set
  `now` between them (FR-008/US3).
- **No-match**: a league list with no `TEAM_NAME` fixture (FR-005/US1 AS4).

The existing `manvfat-fixtures.html` (and the unauthenticated variant) remain for the
parser-shape/auth tests inherited from 003/005.

## Validation scenarios (expected outcomes)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Our next game is not the earliest league game | Poll/selection targets **our** next game, not the earliest league game (US1 AS1) |
| 2 | We are home / we are away | Opponent = the other side in both cases (US1 AS2/AS3) |
| 3 | No fixture features `TEAM_NAME` | No poll; "no confirmed next fixture"; log notes likely `TEAM_NAME` mismatch (US1 AS4 / FR-005) |
| 4 | Today late-Dec, games Dec + Jan (unplayed) | Dec selected as next; Jan recognised as later future, not past (US2 AS1) |
| 5 | Dec game now played, Jan still `-` | Jan selected as next (US2 AS2) |
| 6 | Past game still `-`, later game future | Future game selected; past `-` ignored (US3 AS1 / SC-004) |
| 7 | Game later **today**, not kicked off | Treated as upcoming, selectable (US3 AS3) |
| 8 | Home vs away poll text | Question/options/venue identical (FR-006 / SC-006) |

## `end-of-season` manual checks (US4)

With an in-memory DB seeded with a current season holding games (or via the CLI against a scratch
`.env`):

```bash
# Confirm-by-default: shows the season number and waits for y/N
captain-stats end-of-season

# Non-interactive
captain-stats end-of-season --yes        # or --force
captain-stats end-of-season --json
```

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `end-of-season` + confirm | Current season `is_current=false`, `end_date` set; games/stats preserved (US4 AS1) |
| 2 | Then fetch fixtures (`sync`/`poll`) | New current season (next number); new fixtures stored there; previous season untouched (US4 AS2 / SC-008) |
| 3 | Run without `--yes`, decline | No changes (US4 AS3) |
| 4 | `--yes` / `--force` | Ends without prompt (US4 AS4) |
| 5 | No current season | "No active season to end"; no changes; exit 0 (US4 AS5) |
| 6 | Repeated fetches within a season | No automatic season transition (US4 AS6 / SC-009) |

## Done when

- All scenarios above pass; full suite green (no regression, SC-007).
- `sync`/`fixtures`/`!postpoll` never trigger a season transition (SC-009); only `end-of-season`
  does.
