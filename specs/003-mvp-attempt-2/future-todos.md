# Future TODOs — deferred correctness & robustness findings

**Feature**: `003-mvp-attempt-2` | **Raised**: 2026-06-15 (independent code review of the US2 slice)

These are correctness/robustness gaps surfaced during review of the Gateway-native US2 rework
(`poll-service.ts`, `postpoll-trigger.ts`, `poll.ts`). None block the US2 slice (30/30 tests green),
but each is a real edge worth addressing before release. Ordered by severity.

---

## 1. Concurrent `!postpoll` race (low — largely mitigated by T051)

**Where**: `src/services/poll-service.ts` → `postOrReplaceNextPoll`; `src/whatsapp/postpoll-trigger.ts`.

Any authorized-group member can send `!postpoll`, and the handler always forces. Nothing serializes
the read-modify-write in `postOrReplaceNextPoll`. Two near-simultaneous triggers can both pass the
`getPoll` read, then **both call `sendPoll`** → two real polls posted to the WhatsApp group; the
second DB `insert` can then violate `unique(gameId)` and throw (caught in the handler, logged, **no
in-chat reply**). The Gateway send-limiter throttles sends but not this orchestration.

**Mitigation in place (T051)**: a 5-minute `!postpoll` throttle (`teams.last_poll_posted_at` +
`POSTPOLL_MIN_INTERVAL_MS`) now ignores rapid re-triggers, which removes the realistic spam-replace
footgun. It does **not** close a truly-simultaneous two-message tick (both read the same stale
timestamp before either records a post); there, `unique(gameId)` remains the backstop — at most one
poll row survives, but a duplicate WhatsApp poll could still be posted in that narrow window.

**Remaining fix (if ever needed)**: make the throttle check-and-claim atomic (a conditional
`UPDATE … WHERE last_poll_posted_at IS NULL OR last_poll_posted_at < :cutoff` gating on
rows-affected), or insert-first (claim the `unique(gameId)` row before sending) so a loser aborts
before posting a duplicate poll.

## 2. Crash-window inconsistency during replacement (low–medium)

**Where**: `src/services/poll-service.ts` → `postOrReplaceNextPoll` / `removeExistingPoll`.

Order is `sendPoll(new)` → delete old responses+row → `deleteMessage(old)` → `persist(new keyset)`.
A crash between `sendPoll` and `persist` leaves the **new poll live in WhatsApp but absent from the
DB** — its votes are silently dropped (`resolvePollKeyset → null`) until someone re-triggers. A crash
before the delete leaves a stale old row that `getPoll` still reports as "exists".

**Suggested fix**: wrap the delete-old + persist-new in a single DB transaction, and/or persist the
new keyset immediately after `sendPoll` (before deleting the old). Add a comment documenting the
chosen ordering and its failure mode.

## 3. `!postpoll` is silent in-chat on thrown errors (low)

**Where**: `src/whatsapp/postpoll-trigger.ts` (catch block around `postOrReplaceNextPoll`).

The handler replies in-chat only for `no-fixture` / `fetch-failed`. If `sendPoll` itself throws (a
WhatsApp send failure) or a DB error occurs, the catch logs and returns with **no chat feedback and
no poll**. This is spec-compliant (FR-028 only mandates the two named cases), but the operator can
only discover the failure in logs.

**Suggested fix**: consider a generic in-chat "couldn't post the poll — check the logs" reply on the
caught-error path, or surface a connection-state hint.

## 4. Unsafe gateway cast in the `--dry-run` path (low)

**Where**: `src/cli/commands/poll.ts:52` — `new PollService(db, fixtureService, deps.gateway as IWhatsAppGateway, groupId)`.

In a production `--dry-run`, `deps.gateway` is `undefined`, so an `undefined` is cast to a
non-optional constructor parameter. It works only because `previewNextPoll` never touches the
gateway; a future preview that calls the gateway would NPE, and the `as`-cast sidesteps the strict
typing the constitution asks for.

**Suggested fix**: make the gateway optional/lazy for the preview path, or construct a no-op gateway
for dry-run, so the type system reflects reality.

## 5. Single-team assumption baked in across CLI + seam (medium — multi-team future)

**Raised**: 2026-06-16 (review of the Phase 8 daemon rework).

The MVP is a single-operator, single-team tool, so the daemon (and most of the codebase) assumes
**exactly one team row** in the database. This is fine for the MVP but **will need changing** once
the same database backs multiple teams — every "the team" lookup below would silently pick the wrong
team (or an arbitrary one). Two distinct patterns, both needing a real team selector (CLI flag / env
/ config) before multi-team:

**A. "First team" via `limit(1)`** — implicitly assumes the only row is the right one:
- `src/cli/commands/daemon.ts` — `db.select().from(teams).limit(1)` (the one flagged in review).
- `src/cli/commands/connect.ts` — `--reset` clears the first team's credentials.
- `src/whatsapp/gateway-factory.ts` — `createGateway` loads the **first** team's credential snapshot
  and builds one Gateway. Multi-team means one Gateway/daemon **per team** (one WhatsApp account +
  one authorized group each), so the factory and `daemon`/`connect` would need a team id.
- `src/services/poll-service.ts` — `resolveNextFixture()` and `getLastPollPostedAt()` both
  `limit(1)` on `teams`. The 5-minute `!postpoll` throttle (`teams.last_poll_posted_at`) is therefore
  team-global-but-really-first-team; per-team it must key off the resolved team.
- `src/cli/commands/init.ts` — `limit(1)` guards against re-init; multi-team init needs to allow
  N teams (keyed by name/club URL).

**B. Hardcoded `teamId = 1`** — the CLI view/sync commands assume the team's PK is literally `1`:
- `src/cli/commands/fixtures.ts` (`const teamId = 1`)
- `src/cli/commands/stats.ts` (`const teamId = 1`)
- `src/cli/commands/seasons.ts` (`const teamId = 1`)
- `src/cli/commands/sync.ts` (`options.teamId || 1` — already has a `--team-id` flag, defaults to 1).

**Suggested fix (when multi-team lands)**: introduce a single team-resolution helper (e.g. a required
`--team-id`/`--team-name` flag or `DEFAULT_TEAM_ID` env, resolved once at command entry) and thread the
resolved id through services and the Gateway factory; build one Gateway/daemon per team. Replace every
`limit(1)`-on-`teams` and `teamId = 1` above with that resolved id. The per-team credential snapshot
and `last_poll_posted_at` columns already key on `teamId`, so the schema is multi-team-ready — only the
**selection** logic is hardcoded.

---

> Tree-level note (RESOLVED 2026-06-16): the project previously did not `tsc`-build because
> `src/cli/commands/daemon.ts` referenced the pre-rework `PollService` API
> (`getNextGame`/`postPollForGame`) and deleted modules. Fixed by **T035** (event-router) and
> **T045** (daemon rework, Phase 8) — `npm run build` is now clean; see `tasks.md`.
