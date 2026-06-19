# Contract: `!stats` in-chat trigger (`src/whatsapp/stats-trigger.ts`)

The WhatsApp surface for the season report (US5, FR-019–FR-022). Modelled one-for-one on
`src/whatsapp/postpoll-trigger.ts`. It is a thin trigger: it reuses `AggregateService.getReport`
(FR-013) and `formatReportBlock` (FR-016) and posts the result; it computes nothing new and persists
nothing.

## Exported surface

```text
const STATS_COMMAND = '!stats'
STATS_MIN_INTERVAL_MS: number          // 5 * 60 * 1000 — anti-spam window (FR-021)

isStatsCommand(text: string | null | undefined): boolean

createStatsHandler(deps: StatsHandlerDeps): (message: IncomingMessage) => Promise<void>

interface StatsHandlerDeps {
  aggregateService: AggregateService     // reused as-is (resolveSeason + getReport)
  gateway: IWhatsAppGateway              // sendMessage routes through the gateway RateLimiter (p-queue)
  groupId: string                        // the authorized group the report is posted to
  minIntervalMs?: number                 // defaults to STATS_MIN_INTERVAL_MS; tests pass 0 to bypass
  now?: () => number                     // defaults to Date.now; injected in tests to cross the window
}
```

## `isStatsCommand` (FR-019)

`true` **iff** the whole message, trimmed and lower-cased, equals `!stats`.

| Input | Result |
|-------|--------|
| `!stats`, `  !Stats  `, `!STATS` | `true` |
| `stats`, `!stats now`, `let's check stats`, `!statsx` | `false` |
| `null`, `''` | `false` |

The event-router calls it **before** stat extraction, so the command is never captured as a stat
(beside the existing `isPostPollCommand` gate).

## Handler behaviour

| Situation | Effect |
|-----------|--------|
| Trigger within `minIntervalMs` of the last post | **Ignored** — silent in-chat, logged only (FR-021). |
| Current season resolves + has data | Post `formatReportBlock({ season, players })` to `groupId` via `gateway.sendMessage` — the posted report **is** the success response (FR-020). |
| No current season (`resolveSeason` → `not-found`) **or** season has no data | Post the report's **"no data"** message, not an empty block (FR-020, FR-011). |
| Compute/post throws | Logged; nothing partial sent; never rethrown (FR-022). |
| After any posted message (report or no-data) | Advance the in-memory `lastPostedAt = now()` so repeats are throttled for 5 minutes. |

Every outcome (`posted` / `no-data` / `throttled` / `failure`) is logged (FR-022).

## Throttles (two, complementary)

1. **In-process 5-minute cooldown (FR-021)** — `lastPostedAt` held in the handler closure (not
   persisted; resets on daemon restart, an accepted property). Controlled in tests via `now`.
2. **Gateway outbound rate-limiter (FR-020)** — `gateway.sendMessage` already wraps every send in the
   Gateway's `RateLimiter` (p-queue, ≤5 msg/min). `!stats` uses the **same** queue as `!postpoll`'s
   send; it neither adds nor bypasses a dispatch path.

## Wiring

- `event-router.ts`: add `handleStats` dep; gate `isStatsCommand(message.text)` first, beside
  `isPostPollCommand`, returning before `statService.captureFromMessage`.
- `daemon.ts`: build `new AggregateService(db)` and `createStatsHandler({ aggregateService, gateway,
  groupId })`; pass `handleStats` to `registerEventRouter`. No scraper, no cron — a pure DB read.

## Differences from `!postpoll`

- **Success is not silent** — the posted report is the response (`!postpoll` is silent on success and
  replies only on problems).
- **Throttle state is in-memory**, not a persisted column (`!postpoll` uses `teams.lastPollPostedAt`,
  which exists because a poll is a stored artifact; a report is not).
- **No fixture fetch / no write path** — read-only over already-captured rows.
