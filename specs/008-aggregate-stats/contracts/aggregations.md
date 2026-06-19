# Contract: pure aggregation core (`src/stats/aggregations.ts`)

The reusable calculation layer (FR-013). Pure functions only — **no Drizzle, no I/O, no `console`,
no clock dependence**. Given an `AggregationInput` (see `data-model.md`), they return derived
aggregate objects. Any surface (the `stats` CLI now, an `end-of-season` WhatsApp message later) that
can build the input gets identical results.

## Exported functions

```text
aggregateSeason(input: AggregationInput): SeasonAggregate
aggregatePlayers(input: AggregationInput, opts?: { rankBy?: RankMetric }): PlayerAggregate[]
aggregateAttendance(input: AggregationInput): AttendanceReport
aggregateReport(input: AggregationInput): { season: SeasonAggregate; players: PlayerAggregate[] }

type RankMetric = 'goals' | 'assists' | 'contributions' | 'attendance' | 'weightloss' | 'foodtracking'
```

(Output shapes — `SeasonAggregate`, `PlayerAggregate`, `AttendanceReport` — are defined in
`data-model.md`.)

A rate helper is shared internally and honoured by all of them:

```text
rate(numerator: number, denominator: number): number | null
  // denominator === 0 ? null : numerator / denominator
```

## Behavioural guarantees (what the unit tests pin)

| ID | Guarantee | Requirement |
|----|-----------|-------------|
| A1 | `totalGoals`/`totalAssists` (SeasonAggregate) sum goals/assists over completed-game stat records. | FR-001 |
| A2 | `gamesByStatus` counts every game in `input.games` by status (completed/cancelled/upcoming). | FR-014 |
| A3 | `goalsPerGame`/`assistsPerGame` (SeasonAggregate) = total / completed-games; `null` when no completed games (never `0`, never `NaN`). | FR-001, SC-004 |
| A4 | A player's **attended games** = participation rows with `attended === true`; this is the denominator for that player's per-game and lifestyle rates. | Q2, FR-007 |
| A5 | Per player, `goalsPerGame`/`assistsPerGame` = Σ over attended games / attendedGames; an attended game with no stat record contributes 0 (not excluded); `null` when attendedGames == 0. | FR-004, FR-007, Q2, SC-004 |
| A6 | Per player, `weightLossRate` = count(attended ∧ `down`) / attendedGames; `up`/`same`/`unknown`/missing count toward the denominator (no exclusions); `null` when attendedGames == 0. | FR-008, unification clarification |
| A7 | Per player, `foodTrackingRate` = count(attended ∧ `foodTracking`) / attendedGames; `foodTracking` is defaulted to `false` for null/missing data (same default as `goals → 0`), so every attended game counts toward the denominator; `null` when attendedGames == 0. | FR-010, food-default clarification |
| A8 | Per player, `attendanceRate` = that player's Yes-count / `pollFixtureCount`; `null` when `pollFixtureCount === 0`. | FR-009, FR-015, Q3 |
| A9 | `squadWeightLossRate`/`squadFoodTrackingRate` = **mean** of the per-player rates over attended players (each weighted equally); `null` when there are no attended players. | FR-008, FR-010, Q5(amended) |
| A10 | `averageTurnoutPerFixture` = mean Yes-count over completed poll-bearing fixtures (`pollFixtureCount`); `null` when `pollFixtureCount === 0`. | FR-015, FR-017 |
| A11 | `squadSize` = distinct `canonicalId` across `participation`. | spec §Team aggregates |
| A12 | All grouping keys on `canonicalId`; a person under multiple address forms is counted exactly once. | FR-005, SC-006 |
| A13 | `aggregatePlayers` orders by `rankBy` (default `goals`) highest-first; players with a `null` value for the metric sort last; ordering is otherwise stable. | FR-006 |
| A14 | `hasData` is `false` (caller emits "no data") when the season has no completed games and no participation. | FR-011, SC-004 |
| A15 | `aggregateReport` returns exactly the `aggregateSeason` and default-ranked `aggregatePlayers` outputs — no recomputation, no divergence. | FR-013, FR-016 |
| A16 | SC-002: for any hand-constructed input, every reported number equals an independent hand calculation exactly. | SC-002 |

## Non-goals

- No database access, no season resolution (the service does that and builds the input).
- No formatting/printing (the CLI formatters do that — including the chat-safe `--report` block).
- No clock dependence — aggregates are a pure function of the supplied rows.
