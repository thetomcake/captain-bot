# Data Model: MAN v FAT Captain Stats Tool (MVP, Gateway-native)

**Feature**: `003-mvp-attempt-2` | **Date**: 2026-06-15

Baseline is the existing `src/database/schema.ts`. This document records **only the changes** the
Gateway cutover requires; unchanged tables (`teams`, `seasons`, `games`, `stat_records`) are
reused as-is. The MVP is pre-release (`v0.1.0`); a fresh Drizzle migration may replace the prior
schema rather than migrating Baileys-era rows.

Entities map to spec **Key Entities** and FR-008/FR-012/FR-013/FR-022.

---

## Changed / new tables

### `gateway_credentials` (NEW — replaces `auth_states`)

The opaque Gateway credential snapshot (FR-008). One row per team (single-operator MVP ⇒ one row).

| Column | Type | Notes |
|--------|------|-------|
| `teamId` | integer PK → `teams.id` | one snapshot per team |
| `snapshot` | text NOT NULL | opaque `WhatsAppCredentials` string; persist verbatim, never parse |
| `updatedAt` | timestamp | set on every `onCredentialsUpdate` and on shutdown |

- **DROP** `auth_states` (and its relations) — it stored Baileys `creds` + per-signal-key rows,
  a Baileys-shaped schema that violates FR-006.
- Written from `onCredentialsUpdate(snapshot)` and `getCredentials()` on shutdown; read at startup
  and passed back as `GatewayConfig.credentials`.

### `whatsapp_users` (CHANGED — key by canonical identity)

Now keyed by the Gateway's canonical `Identity` (FR-013, SC-008), not a raw JID.

| Column | Type | Change |
|--------|------|--------|
| `id` | integer PK autoinc | unchanged |
| `canonicalId` | text NOT NULL UNIQUE | **renamed** from `whatsappId`; stores `Identity.canonicalId` |
| `pn` | text NULL | **new** — phone-number form, if known (debug/display) |
| `lid` | text NULL | **new** — LID form, if known |
| `displayName` | text NULL | now sourced from `Identity.displayHint` |
| `firstSeenAt` / `lastSeenAt` | timestamp | unchanged |

- One row per person regardless of address form ⇒ no double-counting.

### Poll identifiers — one id, not two (important)

In WhatsApp/Baileys a poll **is** a message; it has **no separate "poll id"**. The Gateway makes
this concrete: `sendPoll()` sets `pollId = sent.key.id` — i.e. the **poll-creation message's id**.
Therefore a single value serves three roles, and they are always equal:

| Gateway field | Where it appears | Value |
|---------------|------------------|-------|
| `PollSendResult.ref.id` | returned by `sendPoll` (the deletable `MessageRef`) | poll-creation message id |
| `PollSendResult.keyset.pollId` | returned by `sendPoll`; persisted by MVP | **same** id |
| `PollRef.pollId` | passed to `resolvePollKeyset(ref)` on each later vote | **same** id |
| `PollVote.pollId` | emitted by `onPollVote` | **same** id |

So the MVP stores exactly **one** id per poll (named `pollMessageId` below). Use it for the keyset
lookup *and* for `deleteMessage({ id: pollMessageId, groupId })` during replacement (FR-027). There
is no distinct "message id vs poll id" to reconcile.

### `polls` (CHANGED — store the full poll keyset)

The keyset the MVP must persist to decrypt votes after a restart (FR-012/FR-014) is
`{ pollId, groupId, messageSecret, options }`. Three of its four fields map onto existing columns
(`pollId` = `pollMessageId`, `options` = `pollOptions`, `groupId` is the authorized group), so only
`messageSecret` and `groupId` are genuinely new.

| Column | Type | Change |
|--------|------|--------|
| `id` | integer PK | unchanged (internal surrogate key) |
| `gameId` | integer → `games.id`, UNIQUE | unchanged (≤1 active poll per fixture) |
| `pollMessageId` | text NOT NULL | **renamed** from `whatsappMessageId`; the poll-creation message id = keyset `pollId` (see table above) |
| `groupId` | text NOT NULL | **new** — keyset `groupId` (the authorized group JID the poll was posted to) |
| `messageSecret` | text NOT NULL | **new** — keyset `messageSecret`: base64 of the poll's 32-byte secret, exactly as the Gateway returns it. Persist verbatim; the Gateway base64-decodes it on the way back in. |
| `postedAt` | timestamp | unchanged |
| `pollQuestion` | text NOT NULL | unchanged |
| `pollOptions` | json `string[]` | unchanged — keyset `options`. **Must be the exact option strings sent** (the Gateway's decryptor maps each encrypted vote's option *hashes* back to names using these). |

- **Resolver (FR-014)**: `resolvePollKeyset({ pollId, groupId })` → find the poll by
  `pollMessageId == pollId` AND `groupId`; return `{ pollId: pollMessageId, groupId, messageSecret,
  options: pollOptions }`. Return `null` if not found (unknown/replaced poll) ⇒ the Gateway skips
  that vote without error.

### `poll_responses` — the MVP's durable, self-maintained tally (UNCHANGED schema; NEW write semantics)

**The MVP aggregates votes itself; it does NOT rely on the Gateway for a tally.** The Gateway keeps
no durable tally and its `aggregateVotes` helper is a *stateless, in-memory* fold over a `PollVote[]`
array that is **lost on restart** — so it can only ever produce a within-session view. The
authoritative, restart-proof tally is the set of `poll_responses` rows, which the MVP maintains by
persisting **every `onPollVote` delta immediately** as a replace-by-voter update (FR-013):

- voter selects an option → **upsert** the `(pollId, userId)` row to that option name;
- voter changes their vote → the upsert overwrites the prior selection (last-write-per-voter);
- voter withdraws (`PollVote.selectedOptions: []`) → **delete** the row;
- `userId` resolves via `whatsapp_users.canonicalId` (get-or-create by canonical id) so a person
  seen under two address forms collapses to one row (SC-008, no double-count).

Schema unchanged: `unique(pollId, userId)`, `selectedOption`, `respondedAt`. The current tally for a
poll is then just `SELECT … FROM poll_responses WHERE pollId = ?` — derived from persisted rows, not
from any in-memory aggregate. (`aggregateVotes` may optionally be used for an ad-hoc *display* of the
current session's deltas, but never as the source of truth.)

---

## Unchanged tables (reused)

- **`teams`** — `name`, `clubUrl`, `whatsappGroupId` (the authorized group; also held in env).
- **`seasons`** — `seasonNumber`, `startDate`, `endDate`, `isCurrent`, `unique(teamId, seasonNumber)`.
  Season transition flips `isCurrent` and inserts the next number (FR-005).
- **`games`** — `gameDate`, `opponent`, `venue`, `status` (`upcoming|completed|cancelled`),
  `scrapedUrl`, plus `homeTeam`/`awayTeam` (see amendment below). On-demand re-fetches update
  date/time/venue in place; reschedules are handled manually by re-sending `!postpoll` (no
  automatic reschedule detection — FR-026).
- **`stat_records`** — `goals`, `assists`, `weightDirection` (`up|down|same|unknown`),
  `foodTracking` (bool), `confidenceScore` (0–100), `sourceMessage`, `capturedAt`, `editedAt`,
  `unique(gameId, userId)`. Already shaped for US3 capture/merge and US4 view — reused as-is.
  (`editedAt` is retained in the schema but unused this MVP; there is no captain-side correction —
  stored stats change only via a later player-message field-level override, FR-019/FR-024.)

---

## Amendment: home/away on `games` (FR-002a — next-fixture selection fix)

The club page lists the **whole league**, so a stored game must record both sides to (a) identify
which games are *ours* and (b) label the opponent correctly whether we are home or away. `games`
gains:

| column | type | notes |
|---|---|---|
| `homeTeam` | `text NOT NULL` | as printed on the club page |
| `awayTeam` | `text NOT NULL` | as printed on the club page |

`opponent` is retained, now defined as *the opponent from our team's perspective*: for a game our
team (`teams.name` / `TEAM_NAME`) plays, the side that is not us; for a league-only game it defaults
to `awayTeam` and is never consumed. The poll's "next fixture" is the next upcoming `games` row
where `homeTeam` or `awayTeam` matches our team (case-insensitive, trimmed); all league rows are
retained for future use. New Drizzle migration adds the columns; existing current-season rows are
backfilled or cleared-and-re-synced (see `plan-next-fixture-selection.md` → Migration). Persistence
and season-transition identity switch to the stable key `(seasonId, gameDate, homeTeam, awayTeam)`.

## Cascade & integrity rules

- **Poll replacement (FR-027)**: hard-delete the poll's `poll_responses`, then the `polls` row,
  then best-effort `deleteMessage` via the Gateway (failure logged, never blocks). `unique(gameId)`
  enforces the one-poll-per-fixture invariant (delete-before-insert).
- **Season retention (FR-004)**: seasons/games/polls/stats are never cascade-deleted on transition;
  only `isCurrent` toggles. Historical data is preserved indefinitely (SC-007).
- **Identity (SC-008)**: all per-person rows reference `whatsapp_users.id`; the canonical-id unique
  constraint prevents duplicate people.

---

## Type-layer changes (`src/types/entities.ts`)

- Remove `AuthState`; add `GatewayCredential { teamId; snapshot; updatedAt }`.
- `WhatsAppUser`: `whatsappId` → `canonicalId`; add `pn?: string | null`, `lid?: string | null`.
- `Poll`: rename `whatsappMessageId` → `pollMessageId`; add `groupId: string`, `messageSecret: string`.
- `src/types/whatsapp.ts`: remove the `@whiskeysockets/baileys` `proto` import and the
  `WhatsAppMessage`/`PollVoteResult`/`ConnectionState`/`WhatsAppPoll` types (superseded by the
  Gateway's `IncomingMessage`/`PollVote`/`ConnectionStatus`/`PollSpec`, re-exported through the
  port). Keep `ExtractedStats` (pure stat-extractor output).

---

## US6 — View Poll Responses: no schema change (added 2026-06-16)

The `fixtures --show-responses` view (US6, FR-030) is a **read-only projection over existing
tables** — it adds **no columns, tables, or migrations**. It joins:

- `games` (already listed by `fixtures`) → `polls` (`poll.gameId`, at most one per game) →
  `poll_responses` (`selectedOption`, `respondedAt`) → `whatsapp_users` (`displayName`,
  `canonicalId`).

Read-only DTOs live in `src/services/poll-service.ts` (not the DB layer):

- `PollResponseLine = { canonicalId: string; displayName: string | null; selectedOption: string; respondedAt: Date }`
- `GamePollResponses = { pollQuestion: string; responses: PollResponseLine[] }`

The existing `unique(poll_id, user_id)` constraint on `poll_responses` guarantees one line per
canonical identity (no double-counting, FR-013/SC-008); `displayName` is nullable, so the view
falls back to `canonicalId` (FR-030, AS-4).
