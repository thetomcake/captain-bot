---
description: "Task list for MAN v FAT Captain Stats Tool (MVP, Gateway-native)"
---

# Tasks: MAN v FAT Captain Stats Tool (MVP, Gateway-native)

**Input**: Design documents from `/specs/003-mvp-attempt-2/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (gateway-port.md, cli-commands.md), quickstart.md

**Tests**: INCLUDED. Constitution II (Test-First) is NON-NEGOTIABLE and the quickstart names the automated Vitest suite (target < 10 s, SC-010) as the primary acceptance gate. Per-story tests are written first and verified failing before implementation. Interactive WhatsApp paths (QR pairing, live votes) are validated via the Gateway's manual `bin/` entry points + quickstart, NOT the automated suite.

**Organization**: Tasks are grouped by user story. Phase 2 is the foundational **Gateway cutover** — a blocking prerequisite for every WhatsApp-facing story (FR-006).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 (user-story phases only; Setup/Foundational/Polish carry no story label)
- All paths are repo-relative; the project is a single-project CLI per plan.md.

## Path Conventions

- Source: `src/` · Tests: `tests/` · Gateway library (read-only dependency): `src/whatsapp-gateway/**`
- The MVP reaches WhatsApp **only** through `src/whatsapp-gateway/index.ts` (FR-006/SC-011).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the repo for the Gateway cutover; remove dead dependencies.

- [~] T001 Remove the `playwright` and `croner` dependencies via `npm uninstall playwright croner` (so `package.json` **and** `package-lock.json` are updated correctly in one step — do not hand-edit `package.json`). Rationale: research §9 (static parsing only — Playwright excluded entirely) and research §8 (the daemon schedules nothing — no crons — so `croner` is unused). **PARTIAL (split during impl):** `playwright` removed now (truly dead — zero references). `croner` removal **deferred to T045**: it is still imported by `src/cli/commands/daemon.ts`, whose cron job is only removed when the daemon becomes a pure event listener (T045). Removing it earlier breaks `tsc` for no benefit — the daemon file is reworked in Phase 8 regardless. **T045 must run `npm uninstall croner`** as part of dropping the cron job.
- [X] T002 [P] Confirm the Gateway public surface in `src/whatsapp-gateway/index.ts` exports every type/method the seam needs (`ConnectionStatus`, `GroupSummary`, `IncomingMessage`, `MessageRef`, `DeleteOutcome`, `PollSpec`, `PollSendResult`, `PollVote`, `Identity`, `WhatsAppCredentials`, plus `connect`/`disconnect`/`isConnected`/`status`/`listGroups`/`sendMessage`/`sendPoll`/`deleteMessage`/`getCredentials`/`onQR`/`onConnectionChange`/`onMessage`/`onPollVote`); note any gaps in `specs/003-mvp-attempt-2/contracts/gateway-port.md` before coding.
- [X] T003 [P] Verify `vitest` test scripts (`test`, `test:unit`, `test:integration`) and the `:memory:` test-DB helper (`tests/helpers/test-database.ts`) are intact and runnable per `tests/README.md`.

---

## Phase 2: Foundational — Gateway Cutover (Blocking Prerequisites)

**Purpose**: Remove the MVP's direct-Baileys WhatsApp code and replace it with a thin DB-backed seam over the Gateway (FR-006, SC-011). **No user story can begin until this phase is complete.**

**⚠️ CRITICAL**: This is the spec's mandated first work item. Every WhatsApp-facing story builds on this seam.

### Removal (delete Baileys-coupled MVP code)

- [X] T004 Delete the Baileys-bound WhatsApp modules: `src/whatsapp/client.ts`, `src/whatsapp/auth.ts`, `src/whatsapp/message-handler.ts`, `src/whatsapp/poll-manager.ts`.
- [X] T005 Delete the now-unused Baileys-era rate limiter `src/utils/rate-limiter.ts` (rate limiting is Gateway-owned, research §9) and remove its imports/usages from any MVP path.
- [X] T006 [P] Delete the obsolete test doubles/tests tied to removed code: `tests/helpers/mock-whatsapp.ts` and `tests/unit/whatsapp/poll-manager.test.ts`.

### Schema & migration (data-model.md)

- [X] T007 Update `src/database/schema.ts`: DROP `auth_states` and its relations; ADD `gateway_credentials` (`teamId` PK→`teams.id`, `snapshot` text NOT NULL, `updatedAt`); rename `whatsapp_users.whatsappId`→`canonicalId` (UNIQUE) and add nullable `pn`, `lid` (keep `displayName`/`firstSeenAt`/`lastSeenAt`); on `polls` rename `whatsappMessageId`→`pollMessageId` and add `groupId` text NOT NULL + `messageSecret` text NOT NULL. Leave `teams`/`seasons`/`games`/`stat_records`/`poll_responses` schema unchanged.
- [X] T008 Generate a fresh Drizzle migration for the schema in T007 via `npm run db:generate` (pre-release `v0.1.0` — a fresh migration may replace prior Baileys-era schema, data-model.md); verify `src/database/migrate.ts` applies cleanly against a `:memory:` DB.

### Types (data-model.md "Type-layer changes")

- [X] T009 [P] Update `src/types/entities.ts`: remove `AuthState`; add `GatewayCredential { teamId; snapshot; updatedAt }`; change `WhatsAppUser` `whatsappId`→`canonicalId` and add `pn?: string | null`, `lid?: string | null`; on `Poll` rename `whatsappMessageId`→`pollMessageId` and add `groupId: string`, `messageSecret: string`.
- [X] T010 [P] Rewrite `src/types/whatsapp.ts`: remove the `@whiskeysockets/baileys` `proto` import and the `WhatsAppMessage`/`PollVoteResult`/`ConnectionState`/`WhatsAppPoll` types; re-export the Gateway equivalents (`IncomingMessage`/`PollVote`/`ConnectionStatus`/`PollSpec`) via the port; keep `ExtractedStats`.

### Config

- [X] T011 [P] Update `src/config/env.ts`: make `AUTHORIZED_GROUP_ID` required for `daemon`/`poll` (drives exit code `3` when unset, cli-commands.md), default `TIMEZONE`=`Europe/London`, and drop any Baileys-era knobs no longer used.

### The seam (contracts/gateway-port.md)

- [X] T012 Create the MVP-owned port `src/whatsapp/gateway-port.ts` defining `IWhatsAppGateway` (connect/disconnect/isConnected/status/listGroups/sendMessage/sendPoll/deleteMessage + onQR/onConnectionChange/onMessage/onPollVote) and re-exporting the Gateway public types it references. The real `WhatsAppGateway` must satisfy it structurally.
- [X] T013 [P] Write the failing test `tests/integration/whatsapp/credentials-store.test.ts` for the credential store: `load(teamId)` returns `undefined` when empty and the saved snapshot after `save`; `save` upserts a single row and bumps `updatedAt` (real `:memory:` DB).
- [X] T014 Implement `src/whatsapp/credentials-store.ts` (`load(teamId)`/`save(teamId, snapshot)` against `gateway_credentials`, FR-008) to pass T013.
- [X] T015 Implement the Gateway factory `src/whatsapp/gateway-factory.ts` wiring a real `WhatsAppGateway`: `authorizedGroups`=`[AUTHORIZED_GROUP_ID]` (or `[]` for connect/discovery), `credentials` loaded via the credential store, `onCredentialsUpdate`→`credentials-store.save` (FR-008), `resolvePollKeyset(ref)`→the keyset store (T032, wired here), and the MVP logger adapted to the Gateway `Logger` shape (FR-025); leave `minMessageDelayMs`/`reconnect` at Gateway defaults (FR-010). **Impl note:** the keyset store (T027) is Phase 4, so `resolvePollKeyset` is implemented **inline** against the `polls` table (lookup by `pollMessageId == ref.pollId AND groupId`; reconstructed keyset or `null`). **T027 must move this resolver into `keyset-store.resolve` and have the factory delegate.** `createGateway` is async (loads the credential snapshot up front) and accepts `{ discovery, db }`.
- [X] T016 [P] Create the test fake `tests/helpers/fake-gateway.ts` implementing `IWhatsAppGateway` in memory (replaces `mock-whatsapp.ts`): records `sentPolls` (with returned `keyset`), `sentMessages`, `deletedMessages`; exposes `failNextSendPoll`/`deleteOutcomeOverride` toggles, `simulateMessage(Partial<IncomingMessage>)`, `simulatePollVote(PollVote)`, and canonical `Identity` fixtures; imports NO Baileys.

### SC-011 guard

- [X] T017 Add the guard test `tests/integration/whatsapp/no-baileys-import.test.ts`: assert no file under `src/` **except** `src/whatsapp-gateway/**` imports/references `@whiskeysockets/baileys` (SC-011). Run it and confirm it passes after T004–T011.

**Checkpoint**: Direct-Baileys code is gone, the seam compiles, the fake Gateway exists, and the SC-011 guard is green. User stories can now proceed. **Phase 2 note:** `src/cli/commands/connect.ts` was the lone remaining Baileys importer (direct `makeWASocket`) not covered by a deletion; it is reduced to a no-op stub (exit 4, "reworked in T044") so the SC-011 guard passes — **T044 supplies the real Gateway-native `connect`**. Downstream files reworked in later phases (`poll-service.ts` T028, `poll.ts` T030, `daemon.ts` T045) and their tests (`poll-service.test.ts` T024, `poll-command.test.ts` T025) still reference removed code and do **not** yet `tsc`/run — expected until their phases land.

---

## Phase 3: User Story 1 — View Team Fixtures (Priority: P1) 🎯 MVP

**Goal**: Scrape and view a team's upcoming fixtures (date/time/opponent/venue) in chronological order; reflect updates on re-scrape. No WhatsApp dependency. Disposition: **review + light migration** (plan.md).

**Independent Test**: Provide a club URL + team id; verify all fixtures retrieved with correct fields, ordered chronologically, and updates reflected on re-check (SC-001 < 5 s).

### Tests for User Story 1 (write first, verify failing) ⚠️

- [X] T018 [P] [US1] Review/update `tests/integration/fixtures/fixture-retrieval.test.ts` to assert fields present + chronological ordering using the fake scraper (`tests/helpers/mock-scraper.ts`) and static HTML fixtures (acceptance scenarios 1–2). **Done:** added an explicit date/time/opponent/venue presence assertion (FR-002, scenario 1), strengthened the re-sync test to assert updates are reflected (FR-003, scenario 3), and migrated the stale `FR-021`→`FR-003` reference on the change-detection test.
- [X] T019 [P] [US1] Review/update `tests/integration/cli/fixtures-command.test.ts` for the `fixtures` command human + `--json` output (one structural test per output type) and the re-check/update path (scenario 3). **Done:** human + `--json` structural tests already present; added a scenario-3 test asserting the view reflects updated persisted fixture data (FR-003).

### Implementation for User Story 1

- [X] T020 [US1] Review `src/scraping/fixture-scraper.ts` and `src/services/fixture-service.ts`: confirm they import no removed Baileys code, use the shared `src/utils/retry.ts` backoff, and persist via the updated schema; migrate any stale type references (T009). **Done:** grep confirms no `@whiskeysockets/baileys` / removed-module imports; `fetchWithRetry` uses `withRetry` from `utils/retry.ts`; both persist via the unchanged `games` schema and the `Game`/`GameStatus` entity types still align (no stale refs in source).
- [X] T021 [US1] Review/migrate `src/cli/commands/fixtures.ts` and `src/cli/commands/sync.ts` against `contracts/cli-commands.md` (`--all`, `--season <n>`, `--json`; exit codes), ensuring chronological ordering and that `sync` re-scrapes and reflects updates (FR-002/FR-003). **Done:** per the contract `fixtures` is view-only (`--all`/`--season`/`--json`, ordered via `getFixtures`/`getUpcomingFixtures` `ORDER BY gameDate ASC`, exit `0`/`1`/`2`/`3`); `sync` re-scrapes via `syncFixtures`→`fetchFixtures` which upserts venue/status changes (reflects updates, FR-003), exit `0`/`3`. No code change required.
- [X] T022 [US1] Confirm `src/cli/index.ts` routes `fixtures` and `sync`; make T018/T019 pass and verify SC-001 (< 5 s) on the fake-scraper path. **Done:** routes present (`index.ts` `case 'fixtures'`, `case 'sync'`); US1 suite green (20/20) and the SC-001 (< 5 s) fixtures-command perf test passes.

**Checkpoint**: US1 is independently functional and testable on the Gateway-clean codebase.

---

## Phase 4: User Story 2 — Post Availability Polls + Capture Votes (Priority: P2)

**Goal**: Post the next fixture's availability poll to the authorized group via the Gateway — triggered **manually** by an `!postpoll` group message (FR-029) or the `poll` CLI, **not** a cron; on trigger, re-fetch fixtures (on-demand, FR-003) then post or (on re-trigger) force-replace; persist the poll keyset; record every vote against the voter's canonical identity as a durable, replace-by-voter DB tally. Disposition: **rework onto Gateway** (plan.md).

**Independent Test**: Via `FakeGateway.simulateMessage`, send `!postpoll`; verify the system re-fetches fixtures and posts a poll for the correct next fixture (silent on success); send it again → old poll + votes replaced (FR-027); send when no confirmed fixture / scrape fails → no poll, in-chat reply (FR-028); plain "post poll" words → ignored (FR-029). Simulate votes/changes/withdrawals and confirm the DB tally is correct with no double-counting across address forms (SC-008).

### Tests for User Story 2 (write first, verify failing) ⚠️

- [ ] T023 [P] [US2] Write `tests/unit/whatsapp/poll-presenter.test.ts` (replaces the deleted poll-manager test): pure poll question/options formatting from a fixture.
- [ ] T024 [P] [US2] Rewrite `tests/integration/whatsapp/poll-service.test.ts` against `FakeGateway`: `sendPoll` persists the keyset (`messageSecret`+`groupId` onto the poll row, `pollId`→`pollMessageId`, exact `options`); `onPollVote` upserts/deletes `poll_responses` by canonical identity; vote-change overwrites, withdrawal (`selectedOptions: []`) deletes, two address forms collapse to one row (FR-013/SC-008); tally read back from DB rows (acceptance scenario 2).
- [ ] T025 [P] [US2] Update `tests/integration/cli/poll-command.test.ts` for `--dry-run` (re-fetch + preview, send nothing, exit 0), missing `AUTHORIZED_GROUP_ID` (exit 3), **no confirmed next fixture after re-fetch → exit 1** (FR-028), and `--force` replacement (FR-027).

### Implementation for User Story 2

- [ ] T026 [P] [US2] Create `src/whatsapp/poll-presenter.ts` (de-Baileyed poll question/options formatting lifted from the deleted `poll-manager.ts`) to pass T023.
- [ ] T027 [US2] Implement the keyset store `src/whatsapp/keyset-store.ts`: `persist(keyset)` writes `messageSecret`+`groupId` onto the poll row at `sendPoll` time; `resolve(ref)` reconstructs `{ pollId: pollMessageId, groupId, messageSecret, options: pollOptions }` by `pollMessageId == ref.pollId AND groupId == ref.groupId`, or `null` if absent/replaced (FR-012/FR-014). Wire it into `gateway-factory.ts` `resolvePollKeyset` (T015).
- [ ] T028 [US2] Rework `src/services/poll-service.ts` onto `IWhatsAppGateway`: build the `PollSpec` via the presenter, `sendPoll(group, spec)`, persist the poll row + keyset (T027); on `onPollVote` resolve the user via `whatsapp_users.canonicalId` (get-or-create) and persist each delta immediately as a replace-by-voter update of `poll_responses` (upsert, or delete on empty selection) — DB rows are the source of truth, never the Gateway's in-memory `aggregateVotes` (FR-013, research §3a). Also add a shared **orchestration** method `postOrReplaceNextPoll()` (reused by both the `!postpoll` handler and the `poll` CLI): re-fetch fixtures on demand via `fixture-service` (FR-003) → pick the next confirmed fixture; return a structured outcome `{ outcome: 'posted' | 'replaced' | 'no-fixture' | 'fetch-failed', ref? , fixture? }` — `no-fixture` when the scrape yields no confirmed next fixture (placeholder skipped), `fetch-failed` on scrape error; otherwise post (or replace an existing poll via T029).
- [ ] T029 [US2] Implement poll replacement in `poll-service.ts` (FR-027): on re-trigger / `--force`, hard-delete the poll's `poll_responses` then the `polls` row, then best-effort `deleteMessage(ref)` — on `{ ok: false }` log a timestamped warning and continue, never block. (This is also the manual reschedule path: a human re-sends `!postpoll` after a fixture changes — no automatic reschedule detection, FR-026.)
- [ ] T030 [US2] Rework `src/cli/commands/poll.ts` on the port (`contracts/cli-commands.md`) as the **admin escape hatch** for `!postpoll`: call `poll-service.postOrReplaceNextPoll()` (T028); `--dry-run` re-fetches + previews (send nothing, exit 0); default requires `AUTHORIZED_GROUP_ID` (exit 3); `no-fixture`/`fetch-failed` → print why, exit 1 (FR-028); refuses an existing poll unless `--force` (FR-027); prints the poll ref; `--json`. Make T024/T025 pass.
- [ ] T049 [P] [US2] Write `tests/integration/whatsapp/postpoll-trigger.test.ts` (write first, verify failing) driving `FakeGateway.simulateMessage` through the poll-trigger handler: (a) a message equal to `!postpoll` (case-insensitive, trimmed) re-fetches fixtures and posts a poll for the next fixture, recorded in `sentPolls`, **no** in-chat reply on success; (b) a second `!postpoll` hard-deletes the prior poll + responses and posts a fresh one (FR-027); (c) when the scrape yields no confirmed next fixture (placeholder skipped) the handler posts no poll and sends an in-chat reply via `sendMessage` (recorded in `sentMessages`); (d) on scrape failure, no poll + an in-chat error reply (FR-028); (e) a message merely containing the words "post poll" is ignored (treated as ordinary chat, FR-029). Use `FakeGateway` + the fake scraper; placeholder rows already exist in `tests/fixtures/html/manvfat-fixtures.html`.
- [ ] T050 [US2] Implement the `!postpoll` trigger handler `src/whatsapp/postpoll-trigger.ts` (FR-029): export `isPostPollCommand(text)` (whole-message exact match of `!postpoll`, case-insensitive, trimmed) and `handlePostPoll(message)` which calls `poll-service.postOrReplaceNextPoll()` (T028), stays silent in-chat on `posted`/`replaced`, and on `no-fixture`/`fetch-failed` replies in the authorized group via `gateway.sendMessage` ("no confirmed next fixture yet" / "couldn't reach the club site") and logs every outcome with a timestamp (FR-025/FR-028). The event-router (T035) must call `isPostPollCommand` **first** and route to `handlePostPoll`, bypassing stat extraction. Make T049 pass.

**Checkpoint**: US1 + US2 both work independently; `!postpoll` posts/replaces on demand, votes persist durably and survive restart, and unconfirmed-fixture / scrape-failure triggers reply in-chat without posting.

---

## Phase 5: User Story 3 — Capture Player Stats from Chat (Priority: P3)

**Goal**: Capture per-player stats (goals, assists, weight direction, food tracking) from authorized-group messages within the 3-day post-game window, conservatively (≥70% confidence), attributed to the sender's canonical identity, with first-message defaults and later-message field merges. Disposition: **rebuild** (plan.md).

**Independent Test**: Via `FakeGateway.simulateMessage`, send varied stat messages inside/outside the 3-day window and confirm correct capture, thresholding, defaults, and merge (acceptance scenarios 1–5).

### Tests for User Story 3 (write first, verify failing) ⚠️

- [ ] T031 [P] [US3] Write `tests/unit/stats/stat-extractor.test.ts`: pure regex + confidence scoring — `"2 goals, 1 assist, weight down, tracked food"`→{2,1,down,yes}; `"scored today"`→1 goal; `"great game everyone"`→below threshold (no capture); uncertainty markers ("think/maybe/probably") subtract confidence below 70% (FR-016/FR-018, research §6).
- [ ] T032 [P] [US3] Write `tests/integration/stats/stat-capture.test.ts` against `FakeGateway`: within-window capture attributed to `m.sender.canonicalId`; 4+ days→treated as chat, not captured; first message applies defaults (goals=0/assists=0/weight=unknown/tracking=no); later partial message merges only mentioned fields; an explicit correction overrides only the named field (after "2 goals, 2 assists", a later "correction 1 goal" → goals=1, assists stay 2); WhatsApp edits/deletes ignored (FR-017/FR-019/FR-020/FR-024).

### Implementation for User Story 3

- [ ] T033 [P] [US3] Implement the pure extractor `src/stats/stat-extractor.ts` (regex + 0–100 confidence, ≥70% threshold; weight direction only — no weight/BMI values, FR-021) to pass T031.
- [ ] T034 [US3] Implement `src/services/stat-service.ts` capture/merge: resolve sender via `whatsapp_users.canonicalId` (get-or-create), enforce the 3-day window against the relevant game, apply defaults on first capture, merge mentioned fields on subsequent messages, write `stat_records` (FR-015/FR-019/FR-020).
- [ ] T035 [US3] Create the event router `src/whatsapp/event-router.ts` (reworks the deleted `message-handler.ts`): on `onMessage`, **first** check `isPostPollCommand(m.text)` (T050) and route to `handlePostPoll`, returning before any stat parsing (FR-029); otherwise route to stat capture (text + window guard); route `onPollVote` to the poll tally (T028). Make T032 pass (and keep T049 green).

**Checkpoint**: US1–US3 work independently; chat stat capture is conservative and identity-keyed.

---

## Phase 6: User Story 4 — View Historical Stats (Priority: P4, view-only)

**Goal**: View stored stats for any game/season grouped by player; list season history. No captain-side stat correction (FR-024) — stored stats change only via a later player-message override (FR-019). No WhatsApp dependency. Disposition: **rebuild (view-only)** (plan.md).

**Independent Test**: Seed stats across seasons; `stats --game <id>` and `stats --season <n>` show data grouped by player; `seasons` lists all seasons; data persists across seasons (acceptance scenarios 1 & 3).

### Tests for User Story 4 (write first, verify failing) ⚠️

- [ ] T036 [P] [US4] Write `tests/integration/stats/stats-command.test.ts`: `stats --game <id>` and `stats --season <n>` group by player (canonical identity) with goals/assists/weight/food; human + `--json` structural checks; works for a previous season (FR-023, view-only).

### Implementation for User Story 4

- [ ] T037 [P] [US4] Add read queries to `src/services/stat-service.ts` (stats by game, stats by season, grouped by canonical identity) and season listing support in `src/services/season-service.ts`.
- [ ] T038 [US4] Implement `src/cli/commands/stats.ts` (NEW, view-only): `--game <id>`/`--season <n>`/`--json`, grouped output, exit `1` on empty (cli-commands.md).
- [ ] T039 [P] [US4] Implement `src/cli/commands/seasons.ts` (NEW): list seasons (number, date range, current flag) with `--json` (FR-004).
- [ ] T040 [US4] Route `stats` and `seasons` in `src/cli/index.ts`; make T036 pass.

**Checkpoint**: US1–US4 work; historical stats are viewable across seasons.

---

## Phase 7: User Story 5 — Season Transition (Priority: P5)

**Goal**: Detect a new season when all previously scraped fixtures disappear from the club website; create the next season and preserve previous-season data intact. No WhatsApp dependency. Disposition: **implement + review** (plan.md).

**Independent Test**: Simulate the club site dropping all current fixtures and showing new ones; confirm a new season is created, the old season is preserved and still viewable via `seasons`/`stats --season`, with no cross-season contamination (SC-006/SC-007).

### Tests for User Story 5 (write first, verify failing) ⚠️

- [ ] T041 [P] [US5] Write `tests/integration/seasons/season-transition.test.ts`: when all previously scraped fixtures disappear on re-scrape (fake scraper), `shouldCreateNewSeason()` returns true → end current season, create next, new fixtures populate it, prior season/games/polls/stats retained (FR-004/FR-005, SC-006/SC-007).

### Implementation for User Story 5

- [ ] T042 [US5] Implement `SeasonService.shouldCreateNewSeason()` in `src/services/season-service.ts` (currently a `return false` placeholder): true iff every previously scraped fixture is absent from the latest scrape (research §7); reuse existing `endSeason`/`createNewSeason`, toggling `isCurrent` only (no cascade delete).
- [ ] T043 [US5] Wire transition detection into the `sync` path (`src/services/fixture-service.ts` / `src/cli/commands/sync.ts`) so a manual re-scrape can trigger a season transition; make T041 pass.

**Checkpoint**: All five user stories are independently functional on the Gateway-clean codebase.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Wire the daemon (event listener, no crons), finalize connect/QR, and validate the whole suite.

- [ ] T044 [US setup] Rewrite `src/cli/commands/connect.ts` on `connect()` + `listGroups()`: render the `onQR` value as a terminal QR (`qrcode-terminal`) **and** a saved PNG (`qrcode.toFile`, print path) — FR-007; print groups table `id  [addressingMode]  name` and the `AUTHORIZED_GROUP_ID` hint (printed only, FR-011); `--reset`; exit `0`.
- [ ] T045 Rework `src/cli/commands/daemon.ts` as a **pure event listener — NO crons** (`croner` removed, T001): require `AUTHORIZED_GROUP_ID` (exit 3); build the Gateway via the factory; subscribe `onConnectionChange` (log only, FR-010), `onMessage`→event-router (T035: `!postpoll` trigger first, else stat capture), `onPollVote`→poll tally; keep the process alive with no scheduled jobs (all poll posting + fixture fetching is trigger/`sync`-driven, FR-003/FR-012/FR-029); on `SIGINT`/`SIGTERM` persist credentials via `getCredentials()`, `disconnect()`, exit `0`. **Once the cron job and `croner` import are gone from this file, run `npm uninstall croner`** to finish the dependency removal deferred from T001 (it is the last `croner` consumer).
- [ ] T046 [P] Audit `src/utils/logger.ts` usage for the FR-025 timestamped audit trail (polls posted, messages processed, fixtures checked, connection-state changes, errors) across services/commands.
- [ ] T047 [P] Update `CLAUDE.md` and any README pointers to reflect the Gateway-native architecture (seam + ports), removing references to the deleted direct-Baileys modules.
- [ ] T048 Run the full suite (`npm test`) and confirm < 10 s (SC-010), all green, SC-011 guard passing; then walk the `quickstart.md` per-story validation (automated gate) and the manual `connect`/`daemon` interactive paths.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational / Cutover (Phase 2)**: Depends on Setup. **BLOCKS all user stories** (FR-006 — the seam must exist first).
- **User Stories (Phases 3–7)**: All depend on Phase 2.
  - US1 (P1) has no WhatsApp dependency and can start as soon as Phase 2's type/schema changes land.
  - US2 (P2) depends on the keyset store (T027) and the factory/port (T012/T015). The `!postpoll` trigger handler (T049/T050) additionally depends on the US1 fixture-service/scraper (for the on-demand re-fetch and the placeholder-skipping scrape) and is wired into the event-router in T035 (US3).
  - US3 (P3) depends on the event router (T035) and fake Gateway (T016).
  - US4 (P4) depends on `stat_records` reads (US3 schema is unchanged) and seasons.
  - US5 (P5) depends on the fixture-service/scraper (US1).
- **Polish (Phase 8)**: Depends on US1–US5 (daemon wires polls + stats + season detection + connect).

### User Story Dependencies

- **US1 (P1)**: Independent. MVP scope.
- **US2 (P2)**: Independently testable via `FakeGateway`; uses US1 fixtures at runtime but tests stand alone.
- **US3 (P3)**: Independently testable via `FakeGateway.simulateMessage`.
- **US4 (P4)**: Independently testable with seeded data; surfaces US3 records and US5 seasons but does not require them to run.
- **US5 (P5)**: Independently testable via the fake scraper; reuses US1 scraping.

### Within Each User Story

- Tests are written and verified FAILING before implementation.
- Models/schema (Phase 2) → services → CLI/commands → integration (daemon, Phase 8).
- Complete a story before moving to the next priority (or parallelize across developers post-Phase 2).

### Parallel Opportunities

- Phase 1: T002, T003 in parallel (after T001).
- Phase 2: T006, T009, T010, T011 in parallel after the deletions/schema; T013/T016 in parallel; T012 before T015.
- Within a story, all `[P]` test tasks run together, then `[P]` implementation tasks on distinct files.
- Across stories (post-Phase 2): US1, US3, US5 can proceed in parallel by different developers; US2 and US4 layer on once their seam pieces land.

---

## Parallel Example: User Story 2

```bash
# Write all US2 tests first (different files), verify failing:
Task: "tests/unit/whatsapp/poll-presenter.test.ts — pure formatting"
Task: "tests/integration/whatsapp/poll-service.test.ts — keyset persist + vote tally vs FakeGateway"
Task: "tests/integration/cli/poll-command.test.ts — dry-run / exit 3 / no-fixture exit 1 / --force"
Task: "tests/integration/whatsapp/postpoll-trigger.test.ts — !postpoll post/replace/no-fixture/ignore vs FakeGateway"

# Then parallel implementation on distinct files:
Task: "src/whatsapp/poll-presenter.ts"
Task: "src/whatsapp/postpoll-trigger.ts — isPostPollCommand + handlePostPoll (after poll-service)"
# (keyset-store, poll-service, poll command are sequential — shared poll row + service)
```

---

## Implementation Strategy

### MVP First (Cutover + User Story 1)

1. Phase 1: Setup (remove Playwright, confirm Gateway surface).
2. Phase 2: **Gateway cutover** (CRITICAL — delete Baileys code, build the seam, SC-011 guard green).
3. Phase 3: US1 fixtures (review + migrate).
4. **STOP and VALIDATE**: `fixtures`/`sync` work; SC-001 < 5 s; suite green.

### Incremental Delivery

1. Setup + Cutover → seam ready, SC-011 enforced.
2. US1 → fixtures viewable (MVP).
3. US2 → polls posted + votes tallied durably (`FakeGateway`).
4. US3 → stats captured from chat conservatively.
5. US4 → historical stats/seasons viewable.
6. US5 → season transitions detected, history preserved.
7. Polish → daemon + connect wired; full quickstart validation.

### Parallel Team Strategy

1. Whole team completes Setup + Cutover together (single shared seam).
2. Then: Dev A → US1+US5 (scraping/seasons), Dev B → US2 (polls), Dev C → US3+US4 (stats/views).
3. One owner integrates the daemon (Phase 8) once stories land.

---

## Notes

- `[P]` = different files, no incomplete dependencies.
- The MVP never imports Baileys (SC-011, guarded by T017); all WhatsApp behaviour flows through `IWhatsAppGateway`.
- The MVP is the durable tally owner — persist each `onPollVote` delta; never rely on the Gateway's stateless `aggregateVotes` (research §3a).
- No captain-side stat correction (FR-024); `stats` is view-only. Stored stats change only via a later player-message field-level override (FR-019).
- Poll posting is **manually triggered** by `!postpoll` (chat) or the `poll` CLI — the daemon runs no crons (`croner` removed, T001). On trigger the system re-fetches fixtures; with no confirmed next fixture or a scrape failure it posts nothing and replies in-chat (FR-028); a reschedule is handled by re-triggering (FR-026/FR-027/FR-029, T049/T050).
- Commit after each task or logical group; verify tests fail before implementing.
