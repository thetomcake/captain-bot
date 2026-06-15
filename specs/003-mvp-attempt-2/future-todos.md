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

---

> Tree-level note (already tracked, not a new TODO): the project does not `tsc`-build because
> `src/cli/commands/daemon.ts` still references the pre-rework `PollService` API
> (`getNextGame`/`postPollForGame`) and deleted modules. This is resolved by **T035** (event-router)
> and **T045** (daemon rework); see `tasks.md`.
