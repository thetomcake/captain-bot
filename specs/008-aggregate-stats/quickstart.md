# Quickstart: Aggregated Statistics

Validation guide for the new aggregate views on the `stats` command. Proves the four views compute
correct aggregates from already-captured data, in both human and JSON form, across the spec's edge
cases. Detailed shapes and rules live in [data-model.md](./data-model.md); command behaviour in
[contracts/cli-stats-aggregates.md](./contracts/cli-stats-aggregates.md); the pure core in
[contracts/aggregations.md](./contracts/aggregations.md); the `!stats` in-chat trigger (US5) in
[contracts/whatsapp-stats-trigger.md](./contracts/whatsapp-stats-trigger.md).

## Prerequisites

- Repo built (`npm run build`) or run via `tsx`.
- A database with at least one season that has completed games, stat records, and availability poll
  responses. The automated integration test seeds this in-memory; for a manual check, use an
  existing dev DB or `captain-stats sync` + captured stats + poll votes.

## Automated validation (authoritative — SC-002)

```bash
# Pure aggregation maths — the bulk of correctness (hand-calculated fixtures, attended-games edge cases)
npx vitest run tests/unit/stats/aggregations.test.ts

# Service + extended CLI integration — summary / players / attendance / report, no-data, not-found, json, ranking
npx vitest run tests/integration/stats/stats-aggregates.test.ts

# Full suite
npm test
```

These tests are written **before** implementation (Constitution II) and must fail first, then pass.

## Manual smoke scenarios

Run against a populated DB. Replace `<n>` with a real season number.

### US1 — team season summary (P1)

```bash
captain-stats stats --summary --season <n>
captain-stats stats --summary --season <n> --json
```

Expect: total goals, total assists, games-by-status (completed/cancelled/upcoming), goals/assists per
completed game, squad size, average turnout, and squad weight-loss & food-tracking rates (each the
mean of per-player rates). JSON carries the same figures. (FR-001, FR-008, FR-014, SC-001, SC-005)

### US2 — per-player aggregates & leaderboards (P2)

```bash
captain-stats stats --players --season <n>
captain-stats stats --players --season <n> --rank goals
captain-stats stats --players --season <n> --rank attendance --json
```

Expect: one row per player (canonical identity, no duplicates) with totals, **per-attended-game**
rates, attendance %, weight-loss % and food-tracking % (all over the player's attended games); rows
ordered by the chosen metric, highest first; `null` rates render `n/a`. (FR-004, FR-005, FR-006,
FR-007, FR-008, FR-010, SC-006)

### US3 — attendance (P3)

```bash
captain-stats stats --attendance --season <n>
```

Expect: each player's attendance % (Yes votes / completed poll-bearing fixtures) and the squad
average turnout per fixture; poll-less and non-completed fixtures do not skew the figures.
(FR-009, FR-015, Q3)

### US4 — shareable chat report (P2)

```bash
captain-stats stats --report --season <n>
captain-stats stats --report --season <n> --json
```

Expect: a **single contiguous block** — team section (avg attendance/game, total goals/assists, avg
goals/assists per game, avg weight-loss %/week, avg food-tracking %/week, attended players only)
followed by one line per attended player (avg goals/assists per attended game, food-tracking %,
weight-loss %). The human form has no fixed-width columns, box characters, or ANSI — paste it
straight into WhatsApp as one message. JSON emits `{ season, players }`. (FR-016, FR-017, FR-018,
SC-007)

### US5 — `!stats` in-chat report trigger (P2)

Automated (authoritative): `npx vitest run tests/integration/whatsapp/stats-trigger.test.ts` — over
`FakeGateway` + a real `:memory:` DB seeded with a current season, asserts a `!stats` message posts
the report block, a second within the window is ignored, one after the window posts again, a no-data
season posts the "no data" message, and ordinary chat is ignored.

Manual (in a running daemon connected to the authorized group):

```text
# In the WhatsApp group:
!stats
```

Expect: the daemon posts the current season's report block (identical content to
`stats --report`) back into the group — the posted message is the response. A second `!stats` within
5 minutes posts nothing (silently throttled); after 5 minutes it posts again. With no current-season
data, it posts the report's "no data" message. A message merely containing the word "stats" does
nothing. The post is rate-limited by the same Gateway outbound queue as every other message.
(FR-019, FR-020, FR-021, FR-022, SC-008)

## Edge-case checks (SC-004)

| Scenario | Command | Expected |
|----------|---------|----------|
| Season with no recorded data | `stats --summary --season <empty-season>` | "No data" message, exit **2** (not a crash, not misleading zeros). |
| Non-existent season | `stats --summary --season 999` | "Season 999 not found", exit **1**. |
| Player with zero attended games | any view | per-game / lifestyle rates render `n/a` (JSON `null`), never `NaN`/error. |
| Attended game with no stat line | `--players` | counts as a played game with 0 goals/assists, non-`down`, non-tracked (lowers rates, not excluded). |
| Past (non-current) season | `stats --summary --season <old>` | aggregates computed for that historical season. (FR-003, SC-003) |
| Player under multiple address forms | `--players` | counted once (canonical identity). (SC-006) |
| Conflicting view flags | `stats --summary --players` | usage error, exit **2**. |
| Raw view still works | `stats --season <n>` (no aggregate flag) | unchanged legacy per-game line view. |

## Expected exit codes

`0` success · `1` season not found · `2` no data / usage error · `3` unexpected error
(see [contracts/cli-stats-aggregates.md](./contracts/cli-stats-aggregates.md)).

## Reuse check (FR-013)

The aggregation core is importable without the CLI or a DB:

```ts
import { aggregateReport } from '#src/stats/aggregations.js';
const { season, players } = aggregateReport(input); // input built from any source
```

This is what the existing `end-of-season` command would call to post an end-of-season WhatsApp
summary — confirming the calculation is separable from its CLI presentation.
