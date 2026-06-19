# Phase 1 Data Model: Aggregated Statistics

This feature adds **no persisted entities and no schema migration**. Everything below is a *derived,
in-memory* shape computed on demand from existing tables. Source tables (`games`, `stat_records`,
`poll_responses`, `polls`, `whatsapp_users`, `seasons`) are unchanged — see
`src/database/schema.ts`.

The shapes are split into the **input** the pure core consumes, the **outputs** it produces, and the
**computation rules** that map one to the other. The unifying idea is the **attended game**: a
completed game a player answered "available/yes" to. Every per-player rate divides by a player's
attended games (per the 2026-06-19 clarifications).

## Source rows consumed (existing tables)

| Source | Fields used | Notes |
|--------|-------------|-------|
| `games` | `id`, `seasonId`, `status` | `status ∈ {upcoming, completed, cancelled}` drives status counts (FR-014) and the completed-game scope. |
| `polls` | `id`, `gameId` | A fixture has a poll iff a `polls` row references it. Only polls on **completed** games count toward `pollFixtureCount` (Q3/FR-015). |
| `poll_responses` | `pollId`, `userId`, `selectedOption` | One row per (poll, voter) — `unique(pollId, userId)`. **Attended** = `selectedOption === getPollOptions()[0]` (`"Yes"`). |
| `stat_records` | `gameId`, `userId`, `goals`, `assists`, `weightDirection`, `foodTracking` | One row per (game, player) — `unique(gameId, userId)`. `weightDirection ∈ {up,down,same,unknown}\|null`; `foodTracking` boolean\|null in the table — but **null/absent is read as `false` (not tracked)**, the same default as `goals = 0`. Joined onto attended games; absent ⇒ a 0/0, non-`down`, not-tracked attended game. |
| `whatsapp_users` | `id`, `canonicalId`, `displayName` | Canonical identity → one row per person (FR-005/SC-006). Aggregates key on `canonicalId`; `displayName` falls back to `canonicalId` for display. |

## Aggregation input (pure core boundary — `src/stats/aggregations.ts`)

A DB-agnostic object the `AggregateService` builds and the pure functions consume. This is the
FR-013 reuse seam: any surface that can produce this object gets the same aggregates.

```text
AggregationInput {
  scopeLabel: string                       // e.g. "Season 2" — for headings only
  games: GameStatus[]                      // every game in the season (all statuses) — for FR-014 counts
  pollFixtureCount: number                 // # COMPLETED games in the season that have a poll (attendance denom, Q3/FR-015)
  participation: Participation[]           // one row per (completed game, player) the player attended OR has a stat line for
}

GameStatus    { gameId: number; status: 'upcoming' | 'completed' | 'cancelled' }

Participation {
  gameId: number
  canonicalId: string
  displayName: string | null
  attended: boolean                        // voted "Yes" on this completed game's poll
  goals: number                            // 0 when no stat record
  assists: number                          // 0 when no stat record
  weightDirection: 'up'|'down'|'same'|'unknown' | null   // null when no stat record
  foodTracking: boolean                    // DEFAULTS TO false — null/missing food is read as "not tracked", same as goals→0
  hasStatRecord: boolean
}
```

Notes:
- `participation` rows exist only for **completed** games. A row is present when the player attended
  (Yes vote) **or** has a stat record for that completed game. A player's **attended games** are the
  rows with `attended === true`; those form the denominator for all of that player's rates.
- A row with `attended === true, hasStatRecord === false` is the "attended, no stat line" case: it
  contributes a 0-goal/0-assist, non-`down`, non-tracked attended game (Q2 / Edge Cases).
- A row with `attended === false, hasStatRecord === true` is a stat line on a non-attended completed
  game: it is **not** counted in that player's per-game denominator (Edge Cases), and the player
  appears in `--players` with `null` rates if they have no attended games at all.

## Output: SeasonAggregate (US1 `--summary`, and the report team section)

```text
SeasonAggregate {
  scopeLabel: string
  hasData: boolean                         // false ⇒ caller emits "no data" (exit 2, FR-011)
  totalGoals: number                       // Σ goals over completed-game stat records (squad headline, FR-001)
  totalAssists: number
  gamesByStatus: { completed: number; cancelled: number; upcoming: number }   // FR-014
  goalsPerGame: number | null              // totalGoals / completed games; null if no completed games
  assistsPerGame: number | null
  squadSize: number                        // distinct canonicalIds appearing in participation
  averageTurnoutPerFixture: number | null  // mean Yes-count over completed poll-bearing fixtures; null if pollFixtureCount == 0
  squadWeightLossRate: number | null       // MEAN of per-player weight-loss rates over attended players; null if none
  squadFoodTrackingRate: number | null     // MEAN of per-player food-tracking rates over attended players; null if none
}
```

The report's team section (FR-017) is a re-labelling of this: `averageTurnoutPerFixture` →
"average attendance per game", `goalsPerGame`/`assistsPerGame` → "average goals/assists per game",
`squadWeightLossRate`/`squadFoodTrackingRate` → "average weight-loss/food-tracking % per week".

## Output: PlayerAggregate[] (US2 `--players` + leaderboards, and the report per-player section)

```text
PlayerAggregate {
  canonicalId: string
  displayName: string | null
  totalGoals: number                       // Σ goals over the player's ATTENDED games
  totalAssists: number                     // Σ assists over the player's attended games
  totalContributions: number               // totalGoals + totalAssists
  attendedGames: number                    // count of attended games (the per-game denominator)
  goalsPerGame: number | null              // totalGoals / attendedGames; null if attendedGames == 0
  assistsPerGame: number | null
  attendanceRate: number | null            // Yes-responses / pollFixtureCount; null if pollFixtureCount == 0
  weightLossRate: number | null            // (attended ∧ down) / attendedGames; null if attendedGames == 0
  foodTrackingRate: number | null          // (attended ∧ tracked) / attendedGames; null if attendedGames == 0
}
```

`aggregatePlayers(input, { rankBy })` returns the array ordered by `rankBy` (default `goals`),
highest first; players with a `null` value for the metric sort last (stable). One element per
canonical identity (FR-005/SC-006). Players with `attendedGames === 0` (e.g. activity but never voted
Yes) appear with `null` per-game/lifestyle rates.

## Output: AttendanceReport (US3 `--attendance`)

```text
AttendanceReport {
  scopeLabel: string
  hasData: boolean
  averageTurnoutPerFixture: number | null      // squad-level, same value as SeasonAggregate
  players: { canonicalId; displayName; attendanceRate: number | null; attended: number; eligible: number }[]
  // 'eligible' == pollFixtureCount (completed poll-bearing fixtures); poll-less / non-completed fixtures never count (Q3/FR-015)
}
```

## Output: report data (US4 `--report`)

```text
aggregateReport(input) → { season: SeasonAggregate; players: PlayerAggregate[] }
```

No new computation — a convenience that returns both aggregates for the single-block formatter and
for the future WhatsApp surface (FR-013). The formatter renders a chat-safe block (see
`contracts/cli-stats-aggregates.md`).

## Computation rules (the requirements, made precise)

| Rule | Definition | Requirement |
|------|------------|-------------|
| Attended game | completed game where the player voted "Yes" (`getPollOptions()[0]`). The per-player denominator everywhere. | Q2, FR-007, FR-009 |
| Per-game rate null on zero denom | `den === 0 ? null : num / den`. Never `0`, never `NaN`. | FR-007, SC-004 |
| Player goals/assists per game | `Σ goals/assists over attended games / attendedGames`. Attended-no-stat = 0 that game. | FR-004, FR-007, Q2 |
| Player weight-loss rate | `count(attended ∧ weightDirection = 'down') / attendedGames`. `up`/`same`/`unknown`/missing count toward the denominator (no exclusions). | FR-008, unification clarification |
| Player food-tracking rate | `count(attended ∧ foodTracking) / attendedGames`, where `foodTracking` is already defaulted to `false` for null/missing data (same as `goals → 0`). Every attended game counts toward the denominator (no exclusions). | FR-010, food-default clarification |
| Player attendance rate | `count(Yes votes) / pollFixtureCount`. Poll-less / non-completed fixtures excluded. | FR-009, FR-015, Q3 |
| Squad weight-loss / food-tracking rate | **mean** of the per-player rates over attended players (each player weighted equally); null if no attended players. | FR-008, FR-010, Q5(amended) |
| Squad totals (team summary) | `totalGoals`/`totalAssists` = Σ over completed-game stat records; `goalsPerGame` = total / completed games. | FR-001, FR-014 |
| Average turnout | mean Yes-count over completed poll-bearing fixtures (`pollFixtureCount`); null if none. | FR-015, FR-017 |
| Canonical de-dup | all grouping keys on `canonicalId`; a person under multiple address forms counts once. | FR-005, SC-006 |
| Squad size | distinct `canonicalId` appearing in `participation`. | spec §Team aggregates |
| Games by status | count every game in `input.games` by status. | FR-014 |
| No-data | `hasData = false` when the season has no completed games AND no participation. Caller emits "no data", exit 2. | FR-011, SC-004 |

## State & lifecycle

None. Aggregates are pure functions of the source rows at query time; there is no stored state, no
transition, and no write path. Re-running a view after new stats/votes arrive simply recomputes.

## US5 — `!stats` trigger (added 2026-06-19)

The in-chat `!stats` trigger (US5, FR-019–FR-022) introduces **no persisted entity and no schema
change** — it reuses the report shapes above (`SeasonAggregate` + `PlayerAggregate[]` via
`aggregateReport`) and the chat-safe `formatReportBlock`. The only state it holds is an **in-process
last-posted timestamp** (`lastPostedAt: number | null`) inside the handler closure, used solely for
the 5-minute anti-spam throttle (FR-021). It is **not** durable — it resets on daemon restart (an
accepted property per the spec assumption: a restart at worst allows one extra report). No table, no
column, no migration. The report is sent via `gateway.sendMessage`, which already routes through the
Gateway's outbound `RateLimiter` (p-queue) — the second, gateway-level throttle (FR-020), separate
from the in-process cooldown.
