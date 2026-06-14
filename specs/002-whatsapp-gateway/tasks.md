---
description: "Task list for the Standalone WhatsApp Gateway Library"
---

# Tasks: Standalone WhatsApp Gateway Library

**Input**: Design documents from `/specs/002-whatsapp-gateway/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED. The constitution's Principle II (Test-First) is NON-NEGOTIABLE and FR-033 requires an automated boundary suite. Every **pure** unit gets a test task written first (must fail before implementation). Socket-bound orchestration (QR pairing, live connection, live votes) is interactive hardware — excluded from the automated suite per constitution and validated via the manual entry points (`bin/*`) + `quickstart.md`. Note: poll-vote decryption confines its only testable, deterministic part — the option-hash → name mapping — to a pure helper that **is** unit-tested; the Baileys `decryptPollVote` crypto boundary itself is manual-validated.

**Organization**: Tasks are grouped by user story (US1–US5 from spec.md, priority order P1→P5). User stories here are layered (you cannot send without connecting), so later stories build on earlier ones; each remains independently demonstrable via its own entry point once the layers beneath it exist.

## Implementation discipline (NON-NEGOTIABLE)

> This task list was reset after a first attempt (built in one giant step) shipped three blocker defects that the green automated suite did not catch — because they lived in the socket-bound shell. The rules below exist to prevent a repeat. They are mandatory.

- **Small, verified chunks.** Implement one task (or a tight logical group) at a time and **commit per chunk** — never one mega-commit. A reviewer must be able to follow the build incrementally.
- **A task is not `[X]` until it is proven.** Marking a task complete requires its acceptance criteria met AND its tests green; for socket-bound paths it additionally requires the named `quickstart.md` manual smoke to pass. Do **not** check a box on "code written".
- **Push logic out of the untestable shell.** The Baileys-bound shell (`gateway.ts`) is the highest-risk area and is only manual-validated. Prefer extracting decision logic into **pure, unit-tested** units (e.g. the connection-state reducer, T020a) over inlining it in `gateway.ts`. If it isn't pure-testable, it must be covered by a quickstart scenario before `[X]`.
- **Verify Baileys against the installed `7.0.0-rc13` source — invent nothing (FR-031).** The two defects that broke the first attempt (rebuilding auth state on reconnect; a fake LID/PN "try-both") were exactly the items research flagged "re-confirm at implementation time". Read the source, do not trust memory or general docs.
- **The library persists nothing and must survive reconnects on the live in-memory session** — re-read research.md §1/§2/§7 before touching auth, connection, or poll-vote code.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 (omitted for Setup/Foundational/Polish)
- Exact file paths are in each description. All paths are repo-root relative.

## Path Conventions

New, self-contained library tree `src/whatsapp-gateway/` (must NOT touch the MVP's `src/whatsapp/`, services, or `database/schema.ts` — FR-002). Unit tests in `tests/unit/whatsapp-gateway/`. ESM/NodeNext, strict TS, `#src/*` subpath imports (constitution III).

**Message store**: the library keeps a **bounded, in-memory** LRU cache of recently sent/received messages. It backs Baileys' `getMessage` (so our outbound messages/polls are re-sent on a retry-receipt) and is the **first-choice source of a poll's `messageSecret`+options** when the poll-creation message is still cached this session. It is **never persisted** (empty after a restart) and is **not** the consumer's durable store — `resolvePollKeyset` + the consumer-stored keyset remain the durable, restart-proof source of poll secrets.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and structure for the isolated library.

- [X] T001 Create the library tree `src/whatsapp-gateway/` with subfolders `connection/`, `auth/`, `messages/`, `groups/`, `identity/`, `polls/`, `bin/`, and the test folder `tests/unit/whatsapp-gateway/` (per plan.md Project Structure)
- [X] T002 Pin `@whiskeysockets/baileys` to the **exact** installed version `7.0.0-rc13` (remove the `^`) in `package.json`, and add a comment/note that the version is pinned because v7 RC behaviour shifts between releases (research.md "Version / platform summary")
- [X] T003 [P] Add `.wa-creds.json`, `*.wa-creds.json`, and `*.wa-poll-keys.json` to `.gitignore` (consumer-side credential/keyset files used by the manual entry points; the library itself persists nothing)
- [X] T003a [P] ~~Add a working ESLint flat config~~ **DROPPED (decision 2026-06-14).** ESLint is not required by the constitution (Principle III specifies strict typing outcomes, not a linter) or by Spec Kit; it was a pre-existing MVP tool left un-runnable by the ESLint v10 flat-config migration. Rather than carry tooling we don't currently need, ESLint was removed entirely: deleted `eslint.config.js`, `.eslintrc.json`, `.eslintignore`, `tsconfig.eslint.json`, the `lint`/`lint:fix` scripts, and the `eslint`/`@typescript-eslint/*`/`eslint-config-prettier` devDependencies. Strictness (constitution III) is enforced by `tsc --strict` (build `tsconfig.json`) + Prettier for formatting. ESLint can be re-added later if a concrete need arises

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting pieces every user story depends on. No Baileys types may appear in the public surface (`types.ts`, `index.ts`).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Define public domain types in `src/whatsapp-gateway/types.ts`: `ConnectionStatus`, `GroupSummary`, `MessageRef`, `Identity`, `IncomingMessage`, `PollSpec` (question + options only — single-choice; multi-select out of scope), `PollKeyset`, `PollRef`, `PollSendResult`, `PollVote`, `PollOptionResult`, `PollResult`, `DeleteOutcome`, `WhatsAppCredentials` (opaque string), `ReconnectPolicyConfig`, `Logger`, `GatewayConfig` (incl. optional `credentials`/`onCredentialsUpdate`/`resolvePollKeyset` callbacks) (per contracts/gateway-interface.md & data-model.md)
- [X] T005 [P] Write unit test `tests/unit/whatsapp-gateway/config.test.ts` FIRST (must fail): config validation rejects an empty `authorizedGroups`, rejects any entry that is not a group JID (`isJidGroup`), and accepts a valid config — runtime validation of consumer-supplied input that TypeScript cannot enforce (FR-017/FR-018)
- [X] T006 Implement `src/whatsapp-gateway/config.ts`: `GatewayConfig` defaults (`minMessageDelayMs=12000`, `maxRestartHandshakes=5`, reconnect defaults), a no-op default `Logger`, and validation that `authorizedGroups` is non-empty and every entry is a group JID via `isJidGroup` (FR-017/FR-018); the `credentials`/`onCredentialsUpdate`/`resolvePollKeyset` callbacks are optional; make T005 pass (depends on T004, T005)
- [X] T007 [P] Implement a decoupled `src/whatsapp-gateway/rate-limiter.ts` (p-queue-backed, ≤5 msg/min; mirrors the MVP util but owned by the library to stay decoupled — FR-002, FR-016)
- [X] T008 [P] Write unit test `tests/unit/whatsapp-gateway/require-connected.test.ts` FIRST (must fail): `requireConnected(status)` throws a clear error unless `status === 'connected'` (Edge Cases: "operations before connection must fail with a clear error")
- [X] T009 Implement `src/whatsapp-gateway/connection/require-connected.ts` (pure guard that throws unless connected); make T008 pass (depends on T008, T004)
- [X] T010 [P] Write unit test `tests/unit/whatsapp-gateway/identity-resolver.test.ts` FIRST (must fail): LID & PN forms of one person → one `canonicalId`; device suffix stripped; prefers PN; no double-identity (FR-025/FR-026)
- [X] T011 Implement `src/whatsapp-gateway/identity/identity-resolver.ts` using `jidNormalizedUser`/`isLidUser`/`isPnUser` and `*Alt`/`*Pn` counterparts (research.md §10); make T010 pass (depends on T004, T010)
  - **MUST** document that PN↔LID reconciliation here relies on the counterpart arriving in the same `*Alt` field; when `*Alt` is absent the same person seen as LID once and PN another time would otherwise be double-counted (FR-026). Add a code path (or explicit TODO with a tracking note) to consult `sock.signalRepository.lidMapping` (`getLIDForPN`/`getLIDsForPNs`) as the fallback, and record the limitation in the README. T010 MUST cover the alt-present reconciliation cases explicitly
- [X] T012 [P] Write unit test `tests/unit/whatsapp-gateway/group-filter.test.ts` FIRST (must fail): only configured authorized group(s) pass; non-group and other chats rejected (FR-017/FR-018)
- [X] T013 Implement `src/whatsapp-gateway/groups/group-filter.ts` (authorized-group membership + `isJidGroup` guard); make T012 pass (depends on T012)
- [X] T014 [P] Implement `src/whatsapp-gateway/messages/message-store.ts`: a **bounded, in-memory LRU** cache of sent/received messages keyed by `${remoteJid}:${id}`, exposing `set(msg)`, `getMessage(key)` (for Baileys send-retries; may return `undefined`), `getByPollId(groupId, pollId)` (returns the cached poll-creation message for the poll-secret fast-path), and `delete(key)`. Never persisted; holds Baileys message objects internally, exposes none (research.md §2/§7)
- [X] T015 Implement the `WhatsAppGateway` class skeleton + `src/whatsapp-gateway/index.ts` barrel: constructor (consumes `GatewayConfig`), handler registries and subscription methods `onQR`/`onConnectionChange`/`onMessage`/`onPollVote`, and `status()`/`isConnected()` stubs; export only domain types + the `aggregateVotes` helper (no Baileys types) (depends on T004, T006)

**Checkpoint**: Foundation ready — user story implementation can begin.

---

## Phase 3: User Story 1 - Authenticate and stay connected (Priority: P1) 🎯 MVP

**Goal**: Establish and maintain a logged-in session: QR on first use, silent resume after, automatic reconnection on transient drops, terminal stop on non-recoverable, and forced re-auth — all storage-agnostic (consumer persists the opaque snapshot).

**Independent Test**: `bin/connect.ts` → QR appears, scanning reaches `connected`; re-run resumes with no QR; brief network drop auto-recovers; `bin/force-reauth.ts` then forces a fresh QR (quickstart.md Scenarios A & B).

### Tests for User Story 1 (write FIRST, must fail)

- [ ] T016 [P] [US1] Write `tests/unit/whatsapp-gateway/disconnect-classifier.test.ts` FIRST: each `DisconnectReason` code → `restart`/`recover`/`terminal`; `408` (lost/timedOut) → `recover`; `401/403/411/500` → `terminal`; `515` → `restart` (research.md §2)
- [ ] T017 [P] [US1] Write `tests/unit/whatsapp-gateway/reconnect-policy.test.ts` FIRST: exponential backoff is bounded/jittered/capped; restart-handshake counter honours `maxRestartHandshakes` (FR-010/FR-011)
- [ ] T018 [P] [US1] Write `tests/unit/whatsapp-gateway/credentials.test.ts` FIRST: snapshot round-trip `serialize(state)` → `deserialize(snapshot)` ≡ original, preserving Buffers and v7 key types (`lid-mapping`/`device-list`/`tctoken`) via `BufferJSON` (FR-006/FR-008)
  - **MUST** populate a **non-empty** key store before serializing — include at least one entry each of `pre-key`, `session`, **`lid-mapping`**, **`device-list`**, **`tctoken`**, plus a Buffer-valued cred — and assert every key and Buffer survives **byte-for-byte**. (The first attempt serialized an *empty* key store and asserted nothing about keys, so it passed against a serializer that silently dropped them — do not repeat this.)
  - **MUST** exercise the **same** serialize/deserialize the gateway actually uses (T021), not a separate copy
- [ ] T016a [P] [US1] Write `tests/unit/whatsapp-gateway/connection-state.test.ts` FIRST for a **pure connection-state reducer** `(status, event) → { nextStatus, action }`, where `action ∈ { 'connected', 'restart', 'recover', 'terminal', 'none' }`. Cover: `open` → `connected` (+reset counters); `close:515` → `restart` bounded by `maxRestartHandshakes` (exceed ⇒ `terminal`); `close:recover` → `recover` (schedule backoff); `close:terminal` codes → `terminal`; and an **intentional-close flag** ⇒ `none` (no reconnect). This makes the lifecycle that broke the first attempt (C-2 reconnect, H-1 disconnect guard) unit-testable instead of manual-only

### Implementation for User Story 1

- [ ] T019 [US1] Implement `src/whatsapp-gateway/connection/disconnect-classifier.ts` (status code → `DisconnectClass`); make T016 pass (depends on T016)
  - **MUST** make an explicit, documented decision for `440 connectionReplaced` (recover-once vs terminal — research.md §2 says "cautiously or terminal per config") and for `undefined`/unknown status codes. Note in the code that **intentional** closes (operator `disconnect()`/`forceReauth()`) are handled by the reducer's intentional-close flag (T020a) and never reach the classifier
- [ ] T020 [US1] Implement `src/whatsapp-gateway/connection/reconnect-policy.ts` (backoff schedule + restart-handshake cap); make T017 pass (depends on T017)
- [ ] T020a [US1] Implement the **pure connection-state reducer** `src/whatsapp-gateway/connection/connection-state.ts`; make T016a pass. `gateway.ts` (T023) MUST consume this reducer rather than inlining `connection.update` transition logic (depends on T016a, T019, T020)
- [ ] T021 [US1] Implement the single source-of-truth credential serialize/deserialize (creds+keys ↔ opaque `WhatsAppCredentials` via `BufferJSON`); make T018 pass (depends on T018, T004)
  - **MUST** be exactly **one** implementation, used by both the auth store (T022) and the gateway (T023). Do **not** leave a duplicate/dead copy (the first attempt had a dead `credentials.ts` that always serialized `keys: {}` while `auth-state.ts` carried the real logic). `serialize()` **MUST** read the **live** key map and creds — never emit an empty/placeholder key set
- [ ] T022 [US1] Implement `src/whatsapp-gateway/auth/auth-state.ts`: build an in-memory `AuthenticationState` from a snapshot (or `initAuthCreds()`), wrap keys in `makeCacheableSignalKeyStore`, emit `onCredentialsUpdate` on creds/key changes, and `clear()` for re-auth (research.md §1; depends on T021)
  - **MUST** expose `serialize(): WhatsAppCredentials` reflecting current live creds+keys (the gateway needs this for `getCredentials()` and the `creds.update` handler — C-1).
  - **MUST** be built **once per session** and survive socket re-creation. It **MUST NOT** be rebuilt from `config.credentials` on a reconnect or 515 handshake; only `forceReauth()` clears/replaces it (C-2 — this is the bug that broke first-time pairing and reconnect)
- [ ] T023 [US1] Implement connection lifecycle in `src/whatsapp-gateway/gateway.ts`: create the socket with `getMessage` wired to the **message-store** (returns `undefined` on a miss), `creds.update`→`onCredentialsUpdate`; `connect()` resolves on `open`, absorbs the 515 post-pairing handshake bounded by `maxRestartHandshakes`, auto-reconnects `recover` closes via the reconnect-policy, and surfaces `terminal` closes; tolerate benign `MessageCounterError` at debug (FR-030); implement `disconnect()`, `forceReauth()` (logout + `auth-state.clear()`), `getCredentials()`, and emit `onQR`/`onConnectionChange` (depends on T015, T019, T020, T020a, T022, T014)
  - **MUST** drive all `connection.update` transitions through the T020a reducer — do not inline the state machine here.
  - **C-1 — credential persistence:** `getCredentials()` and the `creds.update` handler **MUST** call `authState.serialize()` (live state). They **MUST NOT** return `config.credentials` or any constructor-time snapshot. There **MUST** be exactly one place that pushes `onCredentialsUpdate` so the consumer's file cannot be overwritten with a stale/empty snapshot.
  - **C-2 — session survives reconnect:** the socket **MUST** be (re)created **without** rebuilding `authState`; the live in-memory `authState` (creds+keys) is reused across the 515 handshake and every recover-reconnect. Build it once (T022).
  - **H-1 — intentional-close guard:** `disconnect()` and `forceReauth()` **MUST** set the reducer's intentional-close flag so the resulting `connection:'close'` does **not** schedule a reconnect. `disconnect()` must stay disconnected.
  - **M-2 — no socket/listener leak:** before opening a new socket on reconnect, the previous socket **MUST** be torn down (`ev.removeAllListeners()`, close) and nulled.
  - **Acceptance (manual, T048a):** first pair → the 515 handshake completes with **no** second QR; briefly killing the network resumes on the **same** session (no re-pair); `disconnect()` does not auto-reconnect
- [ ] T024 [P] [US1] Implement `src/whatsapp-gateway/bin/connect.ts`: read `WA_CREDS_FILE`, pass `credentials` + `onCredentialsUpdate` (writes the file), render QR via `qrcode-terminal`, `connect()`, print status (imports only `../index.js`) (contracts/entry-points.md)
- [ ] T025 [P] [US1] Implement `src/whatsapp-gateway/bin/force-reauth.ts`: `forceReauth()` then delete `WA_CREDS_FILE`, print confirmation
  - **MUST** establish the socket first (call `connect()`, or otherwise ensure a live socket) **before** `forceReauth()` so a real best-effort `logout()` is actually attempted against WhatsApp (FR-007). The first attempt constructed the gateway and called `forceReauth()` without connecting, making it a no-op that only deleted the local file. If a pre-connect logout is genuinely not wanted, document explicitly that file-deletion is the sole mechanism

- [ ] T048a [US1] **STOP-AND-VALIDATE gate (do not start US2 until this passes).** Run `quickstart.md` Scenarios A & B against a real test account: (1) first connect shows a QR, scanning reaches `connected`, and the creds file is written; (2) re-run resumes with **no** QR; (3) a brief network kill auto-recovers on the **same** session; (4) `force-reauth` then forces a fresh QR. This is the cheapest check that would have caught the first attempt's blocker defects (C-1 stale creds, C-2 reconnect re-pair). Record the result

**Checkpoint**: US1 fully functional — connect/resume/reconnect/force-reauth demonstrable via entry points; classifier/policy/credentials/guard/reducer unit-tested; **T048a manual gate passed**.

---

## Phase 4: User Story 2 - Send and receive within the authorized group (Priority: P2)

**Goal**: Send text to the authorized group and be notified of genuine inbound messages (sender, text, timestamp), ignoring all other chats and self/echo/append.

**Independent Test**: `bin/listen.ts` reports a phone-sent group message but not a message in another chat nor the bot's own send; `bin/send-message.ts` posts text that appears in the group (quickstart.md Scenario D).

### Tests for User Story 2 (write FIRST, must fail)

- [ ] T026 [P] [US2] Write `tests/unit/whatsapp-gateway/message-mapper.test.ts` FIRST: `notify` → `IncomingMessage`; `append`/echo (`fromMe`) NOT reported as new inbound; text resolved from `conversation` and `extendedTextMessage.text`; timestamp normalized (FR-014/FR-015)

### Implementation for User Story 2

- [ ] T027 [US2] Implement `src/whatsapp-gateway/messages/message-mapper.ts` (WAMessage → `IncomingMessage`, notify-vs-append logic, text/timestamp extraction); make T026 pass (depends on T026, T004)
- [ ] T028 [US2] Wire receive in `src/whatsapp-gateway/gateway.ts`: on `messages.upsert` store every message (any type) in the message-store, then dispatch only `type==='notify'` items that pass the group-filter through message-mapper + identity-resolver (sender) to `onMessage` handlers (depends on T027, T013, T011, T023, T014)
- [ ] T029 [US2] Implement `sendMessage(groupId, text)` in `src/whatsapp-gateway/gateway.ts`: rate-limited, guards via `requireConnected`, stores the sent message in the message-store (for send-retries), returns `MessageRef` (depends on T007, T009, T023, T014)
- [ ] T030 [P] [US2] Implement `src/whatsapp-gateway/bin/send-message.ts` entry point (`WA_GROUP_ID`, `WA_TEXT`)
- [ ] T031 [P] [US2] Implement `src/whatsapp-gateway/bin/listen.ts` entry point (long-running; prints inbound)

**Checkpoint**: US1 + US2 work — two-way messaging in the authorized group, with cross-chat leakage prevented.

---

## Phase 5: User Story 3 - Post polls and capture votes reliably (Priority: P3) 🎯 critical path

**Goal**: Post a native single-choice poll and report an accurate, current per-option voter tally — decrypting votes ourselves (auto-decrypt is disabled in rc13, research.md §7), with correct LID/PN attribution and no double-counting.

**Independent Test**: `bin/send-poll.ts` posts a poll; `bin/watch-votes.ts` prints the live tally as phones vote/change votes, attributing each voter once even across LID/PN forms (quickstart.md Scenario E).

### Tests for User Story 3 (write FIRST, must fail)

- [ ] T032 [P] [US3] Write `tests/unit/whatsapp-gateway/poll-options.test.ts` FIRST: rejects <2 or >12 options and empty option strings; accepts valid specs (single-choice — no `selectableCount` on the public spec) (FR-020)
- [ ] T033 [P] [US3] Write `tests/unit/whatsapp-gateway/poll-tally.test.ts` FIRST for the pure `aggregateVotes(PollVote[])` helper: last-write-per-voter (a later selection replaces the earlier), withdrawal (empty selection) removes the voter, per-option voters canonical with no LID/PN double-count (FR-022/FR-023/FR-026)
- [ ] T034 [P] [US3] Write `tests/unit/whatsapp-gateway/poll-vote-decryptor.test.ts` FIRST for the **deterministic** part of the decryptor: a pure option-hash → name mapping that, given a set of decrypted selected option hashes plus an `options` list, returns the correct option names (and ignores an unknown hash). This covers the most-failure-prone capability's testable logic; the `decryptPollVote` crypto boundary itself stays manual-validated (FR-022/FR-031, SC-005)

### Implementation for User Story 3

- [ ] T035 [US3] Implement `src/whatsapp-gateway/polls/poll-options.ts` (validate 2–12 non-empty options; single-choice only); make T032 pass (depends on T032)
- [ ] T036 [US3] Implement the pure exported helper `aggregateVotes(votes: PollVote[]): PollResult` in `src/whatsapp-gateway/polls/poll-tally.ts` (last-write-per-voter, inverted to per-option voters via identity-resolver); make T033 pass (depends on T033, T011)
- [ ] T037 [US3] Implement `src/whatsapp-gateway/polls/poll-vote-decryptor.ts`: a **pure** option-hash → name mapping (make T034 pass), plus `decryptPollVote(vote, { ..., pollEncKey })` taking the resolved secret (raw bytes) + options from the caller, with the #2342 **try-both** creator/voter LID/PN fallback, then mapping selected option hashes → names (verify the exact hashing/aggregation against the installed source — FR-031); return the voter's selected option names, or null on failure (research.md §7; depends on T034, T011)
  - **C-3 — the try-both MUST be real.** The decryptor MUST receive **both** creator JID forms (PN and LID) plus the voter JID, and make **genuinely distinct** attempts per #2342: `(creator = normalized LID, voter = PN)` first, then `(creator = PN, voter = PN)`. A unit test MUST assert the two attempts use **different** sign-material (the first attempt failed here because the caller pre-normalized both creator forms to one string, so the "fallback" was byte-identical and never a real second try). `decryptPollVote` mixes `pollCreatorJid`/`voterJid` into the HMAC sign + GCM AAD — re-read the installed `process-message.js` `decryptPollVote` before implementing
- [ ] T038 [US3] Implement `sendPoll(groupId, poll)` in `src/whatsapp-gateway/gateway.ts`: validate via poll-options, send the poll with `selectableCount: 1` (single-choice; multi-select out of scope), store the returned poll-creation message in the message-store, read `messageContextInfo.messageSecret` from the result, and return `PollSendResult { ref, keyset }` (keyset = base64 secret + options + ids) (FR-020/FR-021; depends on T035, T029, T014)
- [ ] T039 [US3] Wire vote handling in `src/whatsapp-gateway/gateway.ts`: on an authorized-group `pollUpdateMessage`, build `PollRef`; resolve the secret+options **first from the message-store** (the cached poll-creation message's `messageContextInfo.messageSecret` + `pollCreationMessage.options`), else via `config.resolvePollKeyset(ref)` (null/throw ⇒ skip, no error); decrypt via poll-vote-decryptor, resolve the voter `Identity`, and emit a per-voter `PollVote` via `onPollVote`; cache resolved keysets in-session (FR-021/FR-022/FR-023/FR-024; depends on T037, T011, T028, T014)
  - **C-3 — LID-aware creator identity.** For a poll **we** created (`fromMe`), the creator JID passed to the decryptor MUST be `sock.user.lid` in a LID-addressed group (and `sock.user.id` otherwise) — not `sock.user.id` unconditionally. Read the authorized group's `addressingMode` (from `listGroups`/a metadata cache) to choose, and pass **both** creator forms so the decryptor's try-both (T037) is exercised. This is the production case (the MVP posts its own polls) and the exact path that fails in LID groups today (FR-024)
- [ ] T040 [P] [US3] Implement `src/whatsapp-gateway/bin/send-poll.ts`: post the poll and **append the returned `PollKeyset` to `WA_POLL_KEYS_FILE`** (`WA_POLL_QUESTION`, `WA_POLL_OPTIONS`)
- [ ] T041 [P] [US3] Implement `src/whatsapp-gateway/bin/watch-votes.ts`: wire `resolvePollKeyset` to read `WA_POLL_KEYS_FILE` (return null when unknown), print each per-voter `PollVote`, and show a running aggregate via `aggregateVotes` (long-running). Note: within one session the in-memory store already serves the secret; the keyset file proves the restart-proof fallback path

**Checkpoint**: US1–US3 work — the core poll/vote capability is provably correct, including LID groups.

---

## Phase 6: User Story 4 - Discover available groups (Priority: P4)

**Goal**: List every group the account belongs to, with name + stable id (+ `addressingMode`).

**Independent Test**: `bin/list-groups.ts` prints all groups; empty account → empty result, no error (quickstart.md Scenario C).

### Implementation for User Story 4

- [ ] T042 [US4] Implement `listGroups()` in `src/whatsapp-gateway/gateway.ts` via `groupFetchAllParticipating()` → `GroupSummary[]` (`id`, `subject`→`name`, `addressingMode`); guards via `requireConnected`; empty array when none (FR-019; depends on T023, T009)
- [ ] T043 [P] [US4] Implement `src/whatsapp-gateway/bin/list-groups.ts` entry point (prints id/name/addressingMode table)

**Checkpoint**: US1–US4 work.

---

## Phase 7: User Story 5 - Delete a message or poll the Gateway sent (Priority: P5)

**Goal**: Best-effort revoke of a previously-sent message/poll; clear, non-fatal failure on rejection.

**Independent Test**: `bin/delete-message.ts` revokes a recent message (`{ ok: true }`); an out-of-window/unknown id returns `{ ok: false, reason }` with no crash (quickstart.md Scenario F).

### Implementation for User Story 5

- [ ] T044 [US5] Implement `deleteMessage(ref)` in `src/whatsapp-gateway/gateway.ts`: guards via `requireConnected`; send `{ delete: { remoteJid, fromMe: true, id } }`, wrap in try/catch → `DeleteOutcome` (`window-expired`/`not-found`/`network`/`unknown`), never throw; remove from the message-store (FR-027/FR-028; depends on T023, T009, T014)
- [ ] T045 [P] [US5] Implement `src/whatsapp-gateway/bin/delete-message.ts` entry point (`WA_GROUP_ID`, `WA_MESSAGE_ID`)

**Checkpoint**: All user stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T046 [P] Write `src/whatsapp-gateway/README.md`: usage example + the full public surface so a developer can integrate without reading Baileys docs (FR-032, SC-008)
- [ ] T047 [P] Audit `src/whatsapp-gateway/index.ts` exports to confirm **no Baileys type leaks** into the public surface (Invariant in contracts/gateway-interface.md)
- [ ] T048 Run the unit suite `npx vitest run tests/unit/whatsapp-gateway` — confirm all green and within the fast-suite budget (SC-007)
- [ ] T049 Run format + typecheck for the new tree (`npm run format:check`, `npx tsc --noEmit`) — strict, no `any`, `.js` extensions, `#src/*` imports (constitution III). (ESLint dropped — see T003a; typecheck via `tsc` is the strictness gate.)
  - **MUST** pass `npx tsc --noEmit` (build `tsconfig.json`) with zero errors and `npm run format:check` cleanly before marking `[X]`
- [ ] T050 Execute `quickstart.md` Part 2 manual validation (Scenarios A–F) against a test account/group and record results
  - **MUST** run Scenario E in a **LID-addressed** group specifically (not only a PN group) to prove poll-vote decryption + attribution under LID (FR-024, the core motivation for the rebuild — C-3)

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: depends on Setup; **blocks all user stories**.
- **User Stories (P3–P7)**: depend on Foundational. They are **layered** (the runtime requires a live connection): US2–US5 need US1's connected socket; US3 builds on US2's receive wiring. Implement in priority order P1→P5; each is independently demonstrable via its entry point once its prerequisites exist.
- **Polish (P8)**: depends on all targeted stories being complete.

### User Story Dependencies
- **US1 (P1)**: after Foundational. Foundation of all others.
- **US2 (P2)**: after US1 (needs the connected socket; uses foundational group-filter/identity-resolver/require-connected/message-store).
- **US3 (P3)**: after US2 (reuses the `messages.upsert`/store/group-filter wiring) — the critical path.
- **US4 (P4)**: after US1 (only needs a connection).
- **US5 (P5)**: after US1 (needs send/socket); pairs naturally with US2/US3.

### Within Each User Story
- Pure-unit **tests are written first and must fail** before implementation (constitution II).
- Pure units before the `gateway.ts` wiring that uses them; `gateway.ts` capability before its entry point(s).

### Parallel Opportunities
- Setup: T003 ‖ others.
- Foundational: T004, T007, T014 ‖ ; test files T005 ‖ T008 ‖ T010 ‖ T012 (different files); each impl follows its own test (T006 after T005; T009 after T008; T011 after T010; T013 after T012).
- US1 tests T016 ‖ T017 ‖ T018 (different files) before their impls; entry points T024 ‖ T025.
- US3 test files T032 ‖ T033 ‖ T034 ; entry points T040 ‖ T041.
- Entry points across stories (T030/T031, T043, T045) are independent once their gateway methods exist.
- `gateway.ts` tasks (T023, T028, T029, T038, T039, T042, T044) all edit the same file → **not** parallel with each other.

---

## Parallel Example: User Story 1

```bash
# Write the three pure-unit tests together (must fail first):
Task: "tests/unit/whatsapp-gateway/disconnect-classifier.test.ts"   # T016
Task: "tests/unit/whatsapp-gateway/reconnect-policy.test.ts"        # T017
Task: "tests/unit/whatsapp-gateway/credentials.test.ts"            # T018

# After T023, the two entry points are independent:
Task: "src/whatsapp-gateway/bin/connect.ts"        # T024
Task: "src/whatsapp-gateway/bin/force-reauth.ts"   # T025
```

---

## Implementation Strategy

### MVP First (User Story 1)
1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → 4. **STOP & VALIDATE** (Scenario A/B): connect, resume, reconnect, force-reauth. This alone proves the hardest non-poll problem (session lifecycle) is solved.

### Incremental Delivery
Foundation → US1 (connect) → US2 (messaging) → **US3 (polls/votes — the reason for the rebuild)** → US4 (groups) → US5 (delete). Validate each via its entry point before moving on.

### Notes
- `[P]` = different files, no incomplete dependencies. Tasks editing `src/whatsapp-gateway/gateway.ts` are serialized.
- All Baileys behaviour must match the **pinned `7.0.0-rc13`** verified in research.md — verify against the installed source, invent nothing (FR-031). Re-verify the poll-vote path on any version bump.
- The library writes nothing to disk. Its only in-process state is the bounded, ephemeral **message-store** (send-retries + poll-secret fast-path); it survives no restart. Durable persistence (credentials, poll keysets) lives in the entry points (consumer-side) and, later, the MVP.
- Polls are single-choice for now (multi-select out of scope); `sendPoll` always sends `selectableCount: 1`.
- Poll-secret resolution order: in-session message-store first, then `resolvePollKeyset`; the consumer keyset is the only restart-proof source, so wiring it stays mandatory for production.
- Commit after each task or logical group; do not modify `src/whatsapp/` or other MVP code (FR-002).
