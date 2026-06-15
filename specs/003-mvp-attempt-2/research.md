# Research: MAN v FAT Captain Stats Tool (MVP, Gateway-native)

**Feature**: `003-mvp-attempt-2` | **Date**: 2026-06-15

This MVP reuses the non-WhatsApp research from `001-mvf-captain-stats/research.md` wholesale and
adds only the **Gateway-cutover** decisions. Each section below is either a *reuse pointer* (the
earlier decision still stands) or a *new decision* (changed because WhatsApp now lives behind the
Gateway). All NEEDS CLARIFICATION items from the spec's Clarifications sections are already
resolved there and are recorded as settled decisions.

---

## 1. WhatsApp integration: Gateway-only (NEW — supersedes 001's direct-Baileys design)

**Decision**: Reach WhatsApp **exclusively** through the in-repo Gateway library
(`src/whatsapp-gateway/index.ts`, spec 002). No MVP source file imports `@whiskeysockets/baileys`.
The MVP consumes the Gateway's documented surface: `connect`, `disconnect`, `forceReauth`,
`isConnected`, `status`, `getCredentials`, `listGroups`, `sendMessage`, `sendPoll`,
`deleteMessage`, and the subscriptions `onQR`, `onConnectionChange`, `onMessage`, `onPollVote`,
plus the pure `aggregateVotes` helper.

**Rationale**: 001 built WhatsApp behaviour directly on Baileys; that proved fragile (RC behaviour
shifts, poll decryption, JID/LID identity, reconnection edge cases). The Gateway already
encapsulates and unit-tests all of that and exposes no Baileys types, so the MVP composes a small,
stable contract instead of owning protocol complexity.

**Alternatives rejected**: Keeping the old `WhatsAppClient`/`useDatabaseAuthState` (the source of
the fragility); a second adapter layer over Baileys (duplicates the Gateway).

**Consequence (the seam)**: Introduce an MVP-owned port `IWhatsAppGateway` that the real
`WhatsAppGateway` satisfies structurally and the test `FakeGateway` implements. A `gateway-factory`
constructs the real Gateway with DB-backed `credentials`, `onCredentialsUpdate`, and
`resolvePollKeyset`. See [contracts/gateway-port.md](./contracts/gateway-port.md).

---

## 2. Credential persistence: opaque snapshot in MVP DB (NEW — replaces per-key auth_states)

**Decision**: The Gateway hands the MVP an **opaque `WhatsAppCredentials` string** via
`onCredentialsUpdate` (and on demand via `getCredentials()`). Persist it verbatim in a single-row
`gateway_credentials` table (keyed by team) and pass it back as `GatewayConfig.credentials` on the
next start. Also persist on shutdown via `getCredentials()`.

**Rationale**: The old `auth_states` table stored Baileys `creds` + per-signal-key rows
(`BufferJSON`-serialized) — a Baileys-shaped schema that violates FR-006. The Gateway owns
serialization now; the MVP treats the snapshot as a black box (FR-008).

**Alternatives rejected**: File-based creds (DB already present, simpler single store); keeping
`auth_states` (Baileys-coupled schema).

---

## 3. Poll keyset persistence + vote decryption (NEW)

**One poll id, not two.** Verified in `gateway.ts`: `sendPoll` sets `pollId = sent.key.id` — the
poll-creation **message's** id. So the Gateway's `PollSendResult.ref.id`, `keyset.pollId`,
`PollRef.pollId`, and `PollVote.pollId` are all the **same value**. The MVP stores it once (column
`pollMessageId`) and uses it both as the keyset key and as the `deleteMessage` target. There is no
separate "poll id vs message id" to reconcile (a poll *is* a message in WhatsApp/Baileys).

**Decision**: `sendPoll()` returns `{ ref, keyset }` where `keyset = { pollId, groupId,
messageSecret, options }`. Persist `messageSecret` (base64, verbatim) and `groupId` alongside the
poll row; `pollId` is stored as `pollMessageId` and `options` as `pollOptions`. Wire
`GatewayConfig.resolvePollKeyset(ref)` to look the poll up by `(pollMessageId == ref.pollId AND
groupId == ref.groupId)` and return the reconstructed keyset, or `null` if unknown/replaced (the
Gateway then skips that vote without error, FR-014). `options` must be the exact option strings
sent — the Gateway's decryptor maps each vote's option *hashes* back to names using them.

**Rationale**: Votes are E2E-encrypted with a per-poll `messageSecret` (the 32-byte
`messageContextInfo.messageSecret` of the poll-creation message) that the Gateway keeps no durable
copy of, so the MVP must be the durable store (FR-012). The base64 string is opaque to the MVP —
persist and return it unmodified.

**Vote → DB mapping (the MVP aggregates itself — see §3a)**: `PollVote.selectedOptions` is the
voter's *full current selection* (a delta). For single-choice availability polls it is `[]`
(withdrawal → delete the voter's response row) or one option (upsert by `(pollId, canonicalId)`).
Never double-count across address forms — the voter arrives as a single canonical `Identity`
(FR-013, SC-008).

## 3a. Durable vote aggregation is the MVP's responsibility (NEW — clarification)

**Decision**: The MVP maintains the tally **in its own database**, persisting every `onPollVote`
delta the moment it arrives as a replace-by-voter update of `poll_responses`. The current tally is
read back from those rows. The MVP **must not** depend on the Gateway for a running tally.

**Rationale**: The Gateway emits per-voter deltas and keeps no durable tally; its `aggregateVotes`
helper is a *stateless, in-memory* fold over a `PollVote[]` array. That array lives only in the
running process — after a daemon restart it is empty, and votes cast in the prior session would
vanish from any in-memory aggregate. Persisting each delta as it arrives makes the DB rows the
restart-proof source of truth. `aggregateVotes` is therefore at most an optional convenience for
displaying the *current session's* deltas; it is never the persistent tally.

---

## 4. Canonical identity keying (NEW — replaces raw JID keying)

**Decision**: Key `whatsapp_users` by the Gateway-provided `Identity.canonicalId` (store optional
`pn`/`lid`/`displayHint` for debugging/display). Poll responses and stat records reference the
user row, so one person under two address forms collapses to one row.

**Rationale**: The Gateway already reconciles JID/LID/device forms; the MVP must not re-derive
identity. Storing the canonical id (not a raw JID) is what makes SC-008 (no double-counting)
hold.

**Alternatives rejected**: Storing raw participant JID (the 001 approach) — re-introduces the
double-counting the Gateway exists to prevent.

---

## 5. QR rendering (REUSE of 001 mechanics, now driven by the Gateway's QR value)

**Decision**: Subscribe via `gw.onQR(value)` and render the **raw value** ourselves: a scannable
terminal QR (`qrcode-terminal`) **and** a saved PNG (`qrcode.toFile`) whose path is printed
(FR-007). This is MVP-owned (the Gateway only surfaces the value). The existing `connect.ts`/
`daemon.ts` already contain a working `writeQrPng` + terminal-render helper to lift out of the
deleted Baileys code.

**Rationale**: Operator may scan from terminal or open the image; both are cheap and already
implemented. Only the *source* of the QR string changes (Gateway callback instead of Baileys
`connection.update`).

---

## 6. Stat extraction NLP (REUSE — `001/research.md` §"NLP Extraction")

**Decision**: Pure TypeScript **regex pattern-matching with multi-signal confidence scoring
(0–100)**; capture only at **≥70%** (FR-018); no ML libraries. Patterns cover goals ("scored",
"2 goals", "got one"), assists ("1 assist", "assisted"), weight direction (`up`/`down`/`same`/
`unknown`), food tracking (`yes`/`no`). Uncertainty markers ("think", "maybe", "probably")
subtract confidence so ambiguous messages fall below threshold and are not captured.

**Rationale**: Stat messages are short and constrained; deterministic, sub-millisecond, no
training data, easy to unit-test against the US3 acceptance scenarios. (Unchanged from 001 — this
domain has no WhatsApp coupling.)

**Application rules (from spec FR-019/FR-020)**: capture only within the 3-day post-game window;
first capture applies defaults (goals=0, assists=0, weight=unknown, tracking=no); later partial
messages from the same player **merge** (update only mentioned fields); edits/deletes ignored.

---

## 7. Season-transition detection (NEW DECISION — simplified to the spec's settled rule)

**Decision**: A new season is created when **all** previously scraped fixtures have disappeared
from the club website on a recheck (the spec's carried-forward rule). On detection, end the
current season and create the next (`SeasonService` already has `endSeason`/`createNewSeason`);
new fixtures populate the new season. Previous-season data is retained intact (FR-004/FR-005,
SC-006/SC-007).

**Rationale**: The spec settles season transition as "all previously scraped fixture dates
disappear." This is simpler and more predictable than 001's multi-signal weighted detector
(mass-disappearance / id-reset / temporal-gap at 65% confidence) and avoids false positives from
mid-season page changes. We deliberately adopt the simpler rule the spec dictates; the 001
multi-signal design is recorded there if richer detection is ever needed.

**Alternatives rejected**: 001's weighted multi-signal detector (more complex than the spec
requires); time-based season boundaries (the website is the source of truth).

---

## 8. Scheduling — REMOVED (superseded by the `!postpoll` trigger + on-demand fetch)

**Decision**: The MVP schedules **nothing**; `croner` is **dropped** (removed from `package.json`).
The two former daemon crons are replaced:

- **Post-game poll cron → manual trigger.** An availability poll is posted only when a member sends
  `!postpoll` in the authorized group (FR-029) or the operator runs the `poll` CLI. The handler
  re-fetches fixtures, then posts the next fixture's poll (FR-012); re-triggering force-replaces an
  existing poll (FR-027). When there is no confirmed next fixture or the fetch fails, it posts no
  poll and replies in-chat (FR-028).
- **Daily 06:00 fixture cron → on-demand fetch.** Fixtures are re-fetched only at `!postpoll`,
  `sync`, and `fixtures` runs; season-transition detection (FR-005) runs during those fetches
  (FR-003). There is no scheduled retry — a human re-triggers when ready.

**Rationale**: A human gatekeeps poll posting (they can see when the next fixture is confirmed),
which deletes the scheduling/timezone-cron complexity *and* the automatic unconfirmed-fixture
(old FR-028) and reschedule-detection (old FR-026) machinery. The daemon collapses to a pure
event listener (`onMessage`/`onPollVote`/`onConnectionChange`). WhatsApp reconnection remains
Gateway-owned (FR-010); the daemon only logs connection-state changes. `Europe/London` is still
the default timezone for fixture-date parsing and the 3-day stat window, but is no longer used to
drive any cron.

---

## 9. Scraping, DB, logging, CLI infra (REUSE — `001/research.md`)

**Decisions (unchanged)**:
- **Scraping**: Axios + Cheerio, **static parsing only**; Playwright excluded entirely — remove
  the `playwright` dependency from `package.json` (it is dead weight and contradicts the spec).
  Retry-with-backoff stays a shared scraper utility (`utils/retry.ts`).
- **Database**: Drizzle ORM + better-sqlite3; in-memory (`:memory:`) for tests; per-season
  retention.
- **Logging**: verbose, timestamped audit trail (`utils/logger.ts`) — polls posted, messages
  processed, fixtures checked, connection-state changes, errors (FR-025).
- **CLI**: `minimist` router (`cli/index.ts`), human + `--json` output, stdout/stderr separation.

**Rationale**: These layers have no WhatsApp coupling and are validated by existing/lightly-revised
tests. The only change is removing the now-unused Baileys-era rate-limiter from the MVP path (the
Gateway rate-limits internally).

---

## 10. Testing strategy (REUSE philosophy; NEW Gateway boundary)

**Decision**: Service-boundary mocking only (`tests/README.md`): a **fake fixture scraper**
(`IFixtureScraper`) and a **fake Gateway** (`IWhatsAppGateway`, replacing the deleted
`MockWhatsAppClient`). Real in-memory DB + real Cheerio parsing with static HTML fixtures. Pure
units (`StatExtractor`, `aggregateVotes`, poll presenter, season-transition predicate) tested
directly. A **guard test** asserts no MVP source imports Baileys (SC-011). Interactive paths (QR
pairing, live votes) are validated through the Gateway's manual `bin/` entry points + quickstart,
not the automated suite. Target < 10 s (SC-010).

**Rationale**: Matches the constitution and `tests/README.md`; the Gateway's public surface is the
new, stable boundary the MVP controls its fake against — exactly the boundary the production code
depends on.

---

## Resolved unknowns summary

| Question | Resolution | Source |
|----------|-----------|--------|
| How does the MVP reach WhatsApp? | Gateway public surface only; no Baileys import | §1, FR-006/SC-011 |
| Where do session credentials live? | Opaque snapshot in MVP `gateway_credentials` table | §2, FR-008 |
| Is the poll id separate from the message id? | No — one value (`pollMessageId`); a poll *is* a message | §3 |
| How are votes decrypted after restart? | Persist poll `messageSecret`; serve via `resolvePollKeyset` | §3, FR-012/FR-014 |
| Who keeps the running tally? | The MVP, in its DB (persist each delta); never the Gateway's in-memory aggregate | §3a, FR-013 |
| How is a person identified? | Gateway `Identity.canonicalId`; one DB row per person | §4, FR-013/SC-008 |
| How is the QR shown? | MVP renders surfaced value: terminal QR + saved PNG | §5, FR-007 |
| How are stats parsed? | Pure regex + confidence ≥70% (reuse 001) | §6, FR-015–FR-021 |
| When does a new season start? | All previously scraped fixtures disappear | §7, FR-005 |
| How is everything scheduled? | Nothing scheduled — `!postpoll` trigger + on-demand fetch; `croner` removed | §8, FR-003/FR-012/FR-029 |
| What is mocked in tests? | Fake scraper + fake Gateway at service boundaries only | §10, Constitution II |
