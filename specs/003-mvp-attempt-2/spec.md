# Feature Specification: MAN v FAT Captain Stats Tool (MVP, Gateway-native)

**Feature Branch**: `003-mvp-attempt-2`

**Created**: 2026-06-15

**Status**: Draft

**Input**: User description: "Swap back to the captain-stats MVP after completing the WhatsApp Gateway (spec 002). Rework the MVP onto the Gateway's tested interface: remove all direct-protocol WhatsApp implementation and replace it with the Gateway. Keep the planned user stories as scope but drop the old low-level detail. Reuse existing fixture/scraping/persistence research."

## Overview

This is the MAN v FAT captain-stats tool: it scrapes a club's fixture list, posts availability polls to a team's WhatsApp group, captures player stats from chat, and stores everything per season for later viewing.

It is a **fresh take on the MVP** (superseding the earlier `001-mvf-captain-stats` attempt) built **on top of the completed WhatsApp Gateway library** (spec 002, `src/whatsapp-gateway/`). The earlier attempt specified and built WhatsApp behaviour against the protocol library (Baileys) directly; that proved fragile, so all low-level WhatsApp complexity now lives behind the Gateway's small, stable, tested interface. This feature consumes **only** that interface and never touches the protocol library.

The work **starts by cutting over**: the MVP's existing direct-protocol WhatsApp code is removed and replaced with placeholders that delegate to the Gateway, so the rest of the MVP (fixtures, scheduling, stat parsing, persistence) builds on a clean integration seam. The fixture/scraping/season/persistence research from the earlier attempt is reused; only the WhatsApp-facing design is reworked.

## Glossary

- **Gateway**: the completed WhatsApp Gateway library (spec 002) — the MVP's single integration point for all WhatsApp behaviour.
- **Operator / Captain**: the single person running the tool on a server using their own WhatsApp credentials.
- **Authorized group**: the one WhatsApp group the tool is configured to act on; the Gateway ignores all other chats.
- **Canonical identity**: the single stable "who" the Gateway resolves for every sender/voter, reconciling WhatsApp's two address forms; the MVP keys all people by it and never double-counts.
- **Credential snapshot**: the opaque, JSON-serializable session blob the Gateway hands the MVP to persist and supply back, so the session resumes without re-pairing.
- **Poll keyset**: the per-poll data (decryption secret + options) the Gateway returns from posting a poll; the MVP stores it and supplies it back so later votes can be decrypted.

## Clarifications

### Session 2026-06-15 — Gateway-native MVP (this feature)

These decisions are carried forward as settled; the Gateway (spec 002) now owns all WhatsApp internals.

- Q: How does the MVP reach WhatsApp? → A: **Exclusively** through the Gateway's documented public interface. The MVP MUST NOT import or reference the protocol library (Baileys). The earlier attempt's direct-protocol code is removed and replaced by Gateway usage as the first step.
- Q: Which concerns are owned by the Gateway and therefore out of scope here? → A: QR pairing/generation (the Gateway surfaces the raw QR *value*), forced re-authentication, connection lifecycle and automatic reconnection/backoff, single-group restriction, group listing, message send/receive, native poll posting, poll-vote decryption and per-voter vote events, JID/LID identity canonicalization, outbound rate-limiting, and best-effort message deletion. The MVP composes these capabilities; it does not specify their internals. **QR *rendering* and credential *storage* are NOT in this list — they belong to the MVP (see below).**
- Q: How does the MVP persist WhatsApp session credentials (the Gateway owns no storage)? → A: The Gateway returns an **opaque credential snapshot** via a credentials-update callback (and on demand); the MVP persists it in its own database and supplies it back on next start, so no re-authentication is needed. The snapshot's internal format is opaque (Gateway-internal); the MVP treats it as a black box but owns the storage.
- Q: How are poll votes decrypted? → A: Posting a poll returns a **poll keyset**; the MVP persists it and supplies it back via the Gateway's resolver so later votes decrypt and attribute. The Gateway keeps no durable tally — the MVP aggregates per-voter vote events into the current result.
- Q: How is each person identified for votes and stats? → A: By the **canonical identity** the Gateway resolves (reconciling JID/LID forms); the MVP keys poll responses and stats by it and never double-counts a person appearing under two address forms.

### Session 2026-06-15 — QR rendering & session storage are MVP-owned

- Q: Are QR rendering and session-credential storage owned by the MVP or the Gateway? → A: The **MVP**. The Gateway only surfaces the raw QR *value* (via its QR subscription) and the opaque credential snapshot; the MVP renders the QR and persists credentials in its own database. (Corrects an earlier statement that wrongly listed "QR rendering" and "session-storage mechanics" as Gateway-owned / out of scope.)
- Q: How should the MVP render the QR value surfaced by the Gateway? → A: Render **both** a scannable terminal QR code **and** a saved QR image file (so the operator can scan from the terminal or open the image), printing the image file's path.

### Session 2026-06-15 — Scraping, test DB, and current-code trust

- Q: Is dynamic/headless-browser scraping (Playwright) an option for this MVP? → A: **No.** The MVP relies **only** on static HTML parsing (Axios + Cheerio); dynamic scraping was removed as too complex and is excluded entirely (not deferred).
- Q: Must the test database be in-memory, or is an on-disk test file acceptable? → A: **In-memory only**, for speed (an on-disk test file is not used).
- Q: What is the current trust level of the existing MVP code? → A: The MVP is in a **broken state**; **no existing code is trusted** to work as expected. Every user story must be independently re-verified against its acceptance scenarios before being considered done.
- Q: Are any user stories already implemented? → A: Possibly. Some (e.g., **View Team Fixtures**) appear to work and may need only **review + technical migration**; others may need rework/rebuild. The split is decided during planning, with no existing implementation assumed correct.

### Session 2026-06-15 — `!postpoll` chat trigger & on-demand fetching (simplification)

This session replaces automatic poll scheduling and automatic unconfirmed-fixture/reschedule handling with a single manual, in-chat trigger, and makes all fixture fetching on-demand. It supersedes the earlier "Cron B post-game poll", automatic reschedule detection (old FR-026), the automatic unconfirmed-fixture guard (old FR-028), the daily 06:00 fixture cron (old FR-003 wording), and SC-002.

- Q: Who may trigger a poll by sending the trigger in the group? → A: **Anyone** in the authorized group (accepted trade-off: a re-trigger force-replaces the poll and cascade-deletes its existing votes, and any member can do this — see FR-029 caveat).
- Q: What text fires the trigger? → A: A **distinct command token `!postpoll`**, matched as the **whole message** case-insensitively after trimming whitespace (not natural words like "post poll", to avoid false positives). It is handled **before** stat extraction, so it is never captured as a stat.
- Q: What in-chat feedback does the trigger give? → A: **Silent on success** (the posted poll is its own confirmation); the bot replies in-chat **only on problems** — no confirmed next fixture, or a fixture-fetch failure. All outcomes are logged.
- Q: What happens to the automatic poll machinery? → A: **Removed.** `!postpoll` (chat) and the `poll`/`poll --force` CLI command (admin escape hatch) are the only posting paths. Drop the post-game poll cron, automatic reschedule-driven replacement, the automatic unconfirmed-fixture guard, and SC-002.
- Q: Does fixture fetching stay scheduled? → A: **No — fully on-demand.** There is no daily fixture cron. Fixtures are re-fetched only when `!postpoll` fires, when `sync` runs, and when `fixtures` runs; season-transition detection (FR-005) runs during those fetches.

### Carried-forward MVP decisions (settled in the earlier attempt; unchanged)

- WhatsApp authentication: QR-code pairing on first run, session resumed thereafter (QR is surfaced by the Gateway; the MVP displays it and persists the credential snapshot).
- Node.js runtime: Node.js 22.x (Current).
- Season transition: a new season is created when all previously scraped fixture dates disappear from the club website.
- Fixture update frequency: **on-demand only** — fixtures are re-fetched when `!postpoll` fires, when `sync` runs, and when `fixtures` runs. There is no scheduled daily check (the former 6 AM cron is removed).
- Stat parsing: confidence scoring (0–100%) with a 70% capture threshold.
- Group discovery: a `captain-stats connect` command connects via the Gateway, lists the groups the account belongs to (name + identifier), and prints each identifier so the operator can set `AUTHORIZED_GROUP_ID` in `.env` (printed to console only; not persisted automatically).
- Poll replacement: replacing a poll (by re-sending `!postpoll`, or via the `poll --force` CLI) hard-deletes the old poll and cascade-deletes its responses; best-effort WhatsApp message deletion is requested via the Gateway and never blocks the replacement. There is no automatic reschedule-driven replacement — a human re-triggers when a fixture changes.
- Scraping: **static HTML parsing (Axios + Cheerio) only** — dynamic/headless-browser scraping (e.g., Playwright) is **excluded from this MVP entirely** (removed in the earlier attempt as too complex), not merely deferred. When the club website is unavailable during an on-demand fetch (e.g. an `!postpoll` trigger), the system posts no poll, replies in-chat that the fetch failed, logs it, and waits for the next manual trigger/`sync`.
- Deployment: single-server, single operator using the operator's WhatsApp credentials; "captain" = the operator/admin.
- Logging: verbose, timestamped, for a full audit trail (polls posted, messages processed, fixtures checked, connection-state changes, errors).
- Stat overrides within the 3-day window: later messages override earlier ones; edits/deletes are ignored. Partial messages accepted; no verification or conflict detection across players.
- Test isolation: a real **in-memory** database (NOT an on-disk test file) for speed, with external dependencies mocked **only at their service boundaries** — a fake fixture scraper and a fake Gateway — never by mocking library internals.
- CI test-suite target: under 10 seconds.

## User Scenarios & Testing *(mandatory)*

> **Foundational cutover (precedes the user stories):** before delivering user-facing value, the MVP's existing direct-protocol WhatsApp implementation is removed and replaced with a thin seam over the Gateway (per FR-006). This is technical migration work, not a user story, but it is the first thing done so every story below builds on the Gateway seam.
>
> The five user stories are the planned scope. WhatsApp-facing stories are expressed in terms of the **capabilities the Gateway provides** (connect, list groups, send message, receive message, send poll, read votes, delete message); the MVP composes those with its own domain logic (fixtures, scheduling, stat parsing, persistence) and never specifies how WhatsApp itself is driven.
>
> **Current implementation status (read before planning):** the MVP is presently in a **broken state**, and **no existing code is trusted to work as expected** — each user story's acceptance scenarios MUST be independently re-verified against the Gateway-clean codebase before that story is considered done. Some stories may already be partially or fully implemented in the existing code: for example, **View Team Fixtures (US1) appears to work** and is expected to need only **review + technical migration** (re-verification, plus decoupling from any removed direct-protocol code), whereas others may need substantial rework or rebuild. The per-story split between "review + migrate" and "rebuild" is determined during `/speckit-plan` by assessing the existing code against each story's acceptance scenarios; this spec does not assume any existing implementation is correct.

### User Story 1 - View Team Fixtures (Priority: P1)

As a team captain, I need to see my team's upcoming fixtures so I can plan ahead and know when to post availability polls.

**Why this priority**: Foundational — without fixture information, no other functionality (polls, stats) can work. It is the entry point for everything else and has no WhatsApp dependency.

**Independent Test**: Provide a club URL and team identifier, then verify all fixtures are retrieved with correct date, time, opponent, and venue and ordered chronologically.

**Acceptance Scenarios**:

1. **Given** I provide my club URL (e.g., `manvfatfootball.com/club/watford/`) and team identifier, **When** the system fetches fixtures, **Then** I see all upcoming games with date, time, opponent, and venue.
2. **Given** fixtures exist on the club website, **When** I view the fixture list, **Then** I see them ordered chronologically.
3. **Given** fixtures have been updated on the club website, **When** the system rechecks, **Then** I see the updated information reflected.

---

### User Story 2 - Post Availability Polls (Priority: P2)

As a team member, I need to post an availability poll for the next fixture to the WhatsApp group by sending `!postpoll` in the group, so the team can gauge who's available without anyone needing server/CLI access.

**Why this priority**: Replaces a repetitive post-game captain task with a one-word in-chat command. Depends on fixture data (P1) and on the Gateway's send-poll / read-votes capabilities, but is independently valuable. The manual trigger removes the need to auto-schedule posts or auto-handle unconfirmed/rescheduled fixtures.

**Independent Test**: Via `FakeGateway`, simulate an `!postpoll` message in the authorized group; verify the system re-fetches fixtures and posts a poll for the correct next fixture (and, when no fixture is confirmed or the fetch fails, posts no poll and replies in-chat). Cast votes and verify each is recorded against the correct person and the running tally matches; re-send `!postpoll` and verify the old poll + votes are replaced.

**Acceptance Scenarios**:

1. **Given** the next fixture is confirmed, **When** any group member sends `!postpoll`, **Then** the system re-fetches fixtures and posts an availability poll for the next fixture to the authorized WhatsApp group (no reply on success).
2. **Given** a poll has been posted, **When** players vote, **Then** each response is recorded against the voter's canonical identity and the running tally reflects vote changes and withdrawals.
3. **Given** multiple fixtures exist, **When** `!postpoll` is sent, **Then** the poll references the correct next fixture.
4. **Given** a poll already exists for that fixture slot, **When** `!postpoll` is sent again (or `poll --force` is run), **Then** the existing poll and all its recorded votes are hard-deleted and a fresh poll is posted (FR-027).
5. **Given** no next fixture is confirmed (or the club site is unreachable), **When** `!postpoll` is sent, **Then** no poll is posted and the bot replies in-chat explaining why (FR-028).

---

### User Story 3 - Capture Player Stats from Chat (Priority: P3)

As a team captain, I need player stats (goals, assists, weight direction, food tracking) captured automatically from WhatsApp messages in the 3 days after a game so I don't have to track and enter them manually.

**Why this priority**: Provides automation value but is less critical than fixtures and availability. Players can still report manually if needed. Depends on the Gateway's receive-message capability.

**Independent Test**: Send test messages with various stat formats during the 3-day window after a game (delivered to the MVP via the Gateway's message notifications) and verify correct capture and attribution to the sending player's canonical identity.

**Acceptance Scenarios**:

1. **Given** a game was played and it's within 3 days, **When** a player messages "2 goals, 1 assist, weight down, tracked food", **Then** stats are captured: goals=2, assists=1, weight=down, tracking=yes.
2. **Given** a player messages "scored today" within 3 days of a game, **When** the system processes the message, **Then** 1 goal is attributed to that player for that game.
3. **Given** it's been 4 days since the last game, **When** a player mentions goals, **Then** the message is treated as regular chat and not captured as stats.
4. **Given** a player sends general chat like "great game everyone", **When** the system processes it, **Then** no stats are captured (conservative approach).
5. **Given** a player doesn't mention a stat component, **When** the system processes their first message, **Then** defaults are applied: goals=0, assists=0, weight=unknown, tracking=no.

---

### User Story 4 - View Historical Stats (Priority: P4)

As a team captain, I need to view stats for any game this season or from previous seasons so I can review accurate records over time.

**Why this priority**: Important for data integrity but less urgent than core automation. No WhatsApp dependency.

> **Correction is player-driven, not captain-driven.** There is no captain-side stat-editing command in this MVP. Stored stats are corrected only by the player sending a further message within the 3-day window (a field-level override per FR-019) — e.g. after "2 goals, 2 assists", a later "correction 1 goal" sets goals=1 and leaves assists=2 unchanged. `stats` is therefore **view-only**.

**Independent Test**: View stored stats and verify persistence across sessions and seasons.

**Acceptance Scenarios**:

1. **Given** stats have been captured for a game, **When** I view that game's stats, **Then** I see all captured data organized by player.
2. **Given** multiple seasons exist, **When** I select a previous season, **Then** I can view all games and stats from that season.

---

### User Story 5 - Season Transition (Priority: P5)

As a team captain, I need the system to recognize automatically when a new season starts so historical data is preserved and new data doesn't overwrite previous seasons.

**Why this priority**: Critical for long-term data integrity but only exercised at season boundaries. No WhatsApp dependency.

**Independent Test**: Simulate a season-end scenario where the last fixture completes and new fixtures appear, verifying a new season is created while the old one is preserved.

**Acceptance Scenarios**:

1. **Given** the last game of a season has been played and new fixtures appear, **When** the system detects the change, **Then** a new season is created and previous season data remains intact.
2. **Given** multiple seasons exist, **When** I view historical data, **Then** I can distinguish between seasons and access data from any season.

---

### User Story 6 - View Poll Responses (Priority: P6)

As a team captain, I need to see who has voted and how on the availability polls — names and their availability choice, across the polls — so I can read availability per fixture from the CLI without scrolling WhatsApp.

**Why this priority**: A read-only convenience over data US2 already captures. It adds no WhatsApp/Gateway behaviour and depends only on stored polls and responses, so it is the lowest-risk story and naturally last. It is delivered as a flag on the existing `fixtures` view (`--show-responses`) rather than a new command, so availability sits next to the fixture it belongs to.

**Independent Test**: Seed games with a poll and several votes (including a voter with no display name, and a fixture with no poll), run `fixtures --show-responses`, and verify each fixture's poll shows every voter's name (canonical identity as fallback) and availability choice, that a fixture without a poll is shown without error, and that `--json` carries the same data.

**Acceptance Scenarios**:

1. **Given** a fixture has a poll with recorded votes, **When** I run `fixtures --show-responses`, **Then** under that fixture I see each voter's name and their availability choice (Yes/No/Maybe).
2. **Given** a listed fixture has no poll, **When** I run `fixtures --show-responses`, **Then** that fixture is shown as having no poll (no error, no missing-data crash).
3. **Given** a poll exists but no one has voted yet, **When** I run `fixtures --show-responses`, **Then** that fixture's poll is shown with no responses rather than being omitted.
4. **Given** a voter has no stored display name, **When** their response is shown, **Then** their canonical identity is displayed instead (consistent with the `stats` view).
5. **Given** I do not pass `--show-responses`, **When** I run `fixtures`, **Then** the output is unchanged from today (the flag is purely additive).
6. **Given** `--json`, **When** I run `fixtures --show-responses --json`, **Then** each fixture object carries its poll responses (name + choice) or a null poll.

---

### Edge Cases

- When the club website is unavailable during an on-demand fetch triggered by `!postpoll`, the system posts no poll, replies in-chat that the club site couldn't be reached, logs it, and waits for the next manual trigger/`sync` (FR-028). There is no scheduled retry.
- When a fixture is rescheduled, a human re-sends `!postpoll` (or runs `poll --force`); the system re-fetches fixtures and replaces the poll — hard-deleting the old poll and its responses, requesting best-effort deletion of the old poll message via the Gateway, and posting a new poll with updated details (FR-026/FR-027). The system does not auto-detect reschedules.
- When `!postpoll` is sent but the next fixture is not yet confirmed — the club website shows a "Fixtures to be confirmed" placeholder rather than a concrete date/time/opponent — the system posts **no** poll and replies in-chat that there is no confirmed next fixture; the sender re-triggers once details appear (FR-028). (The scraper skips "Fixtures to be confirmed" rows, so an unconfirmed slot yields no postable next fixture; the test HTML fixture `tests/fixtures/html/manvfat-fixtures.html` contains such placeholder rows.)
- Because **any** group member can send `!postpoll`, a member can accidentally or deliberately re-trigger a replacement that hard-deletes an existing poll and all its recorded votes; this is an accepted trade-off for MVP simplicity (FR-029) — there is no per-member authorization on the trigger.
- A group message that merely mentions the words "post poll" in normal conversation does NOT trigger anything; only a whole message equal to `!postpoll` (case-insensitive, trimmed) is treated as the command (FR-029).
- When the Gateway reports that the old poll message could not be deleted (window expired, message already gone, or network failure), the MVP logs a warning with a timestamp and proceeds with the database deletion and new poll; WhatsApp message deletion is best-effort and never blocks the replacement.
- When a player edits or deletes a WhatsApp message containing stats, the edit/delete is ignored; players can send a new message within the 3-day window to override their previous stats.
- For ambiguous stat messages ("think I got 2", "maybe assisted"), confidence scoring below the 70% threshold results in no capture (FR-018).
- When multiple players each claim goals for the same game, all claims are accepted without verification; there is no captain-side correction (FR-024) — a player who over/under-reported corrects their own totals by sending a follow-up message within the 3-day window (field-level override, FR-019).
- Players who leave the team mid-season remain in historical stats; no special handling is needed for the MVP (stats are per-game snapshots).
- When the WhatsApp connection drops, the Gateway automatically reconnects on recoverable disconnects and surfaces a terminal state on non-recoverable ones; the MVP logs connection-state changes but takes no reconnection action itself.
- Before running `captain-stats daemon`, the operator MUST first run `captain-stats connect` to authenticate (scan the QR the MVP renders — in the terminal or from the saved image file — from the Gateway's surfaced QR value), identify the target group from the listed groups, and set `AUTHORIZED_GROUP_ID=<id>` in `.env`; the daemon exits with a clear error if `AUTHORIZED_GROUP_ID` is not configured.
- A poll vote whose keyset the MVP cannot supply (unknown/expired/replaced poll) is skipped by the Gateway without error; the MVP simply records no response for it.
- Timezone handling defaults to UK time, sufficient for the UK-based MAN v FAT Football.

## Requirements *(mandatory)*

### Functional Requirements

#### Gateway cutover (foundational)

- **FR-006**: The MVP MUST perform **all** WhatsApp interactions exclusively through the WhatsApp Gateway library's documented public interface, and MUST NOT import, reference, or otherwise depend on the underlying protocol library (Baileys) directly. As the first work item, the earlier attempt's direct-protocol WhatsApp implementation MUST be removed and replaced with a thin seam that delegates to the Gateway.

#### Fixtures & seasons

- **FR-001**: System MUST support any MAN v FAT club identified by its club page URL on `manvfatfootball.com` (e.g., `manvfatfootball.com/club/watford/`) and the captain's team within that club.
- **FR-002**: System MUST retrieve team fixtures from the club page including date, time, opponent, and venue.
- **FR-003**: System MUST re-fetch fixtures **on demand** and reflect changes — when `!postpoll` fires (FR-029), when the `sync` command runs, and when the `fixtures` command runs. There is **no** scheduled/daily fixture check; all refreshing is triggered by one of these actions.
- **FR-004**: System MUST retain historic data across multiple seasons.
- **FR-005**: System MUST detect season transitions when previously scraped fixtures are no longer present on the club website — evaluated during on-demand fetches (`!postpoll`, `sync`, `fixtures`; FR-003) rather than on a schedule — creating a new season while preserving previous season data.

#### WhatsApp integration (via the Gateway library — spec 002)

- **FR-007**: System MUST authenticate with WhatsApp through the Gateway on first run by taking the raw QR value the Gateway surfaces (via its QR subscription) and **rendering it itself** — both as a scannable terminal QR code and as a saved QR image file whose path it prints — so the operator can pair by scanning either. On subsequent runs it MUST resume the session without a fresh scan. (QR *pairing/generation* and reconnection internals are owned by the Gateway; QR *rendering* is the MVP's responsibility.)
- **FR-008**: System MUST persist the opaque session-credential snapshot the Gateway provides (via the Gateway's credentials-update callback and on shutdown) in its own database, and supply it back to the Gateway on next start so re-authentication is not required.
- **FR-009**: System MUST configure the Gateway with exactly one explicitly-authorized WhatsApp group and rely on the Gateway to ignore all other chats; the system MUST NOT itself process activity from any other chat.
- **FR-010**: System MUST observe the Gateway's connection lifecycle (connecting / connected / closed / terminal) and log each state change with a timestamp; automatic reconnection on recoverable disconnects is performed by the Gateway, so the system MUST NOT implement its own reconnection or backoff.
- **FR-011**: System MUST provide a `captain-stats connect` command that connects through the Gateway, lists every group the account belongs to (display name + stable identifier) using the Gateway's group-listing operation, and prints each identifier to the console so the operator can set `AUTHORIZED_GROUP_ID` in `.env`. No identifier is persisted automatically.

#### Availability polls

- **FR-012**: System MUST post an availability poll for the next fixture **only when manually triggered** — by an `!postpoll` message in the authorized group (FR-029) or by the `poll` CLI command — by first re-fetching fixtures (FR-003) and then calling the Gateway's send-poll capability; it MUST persist the **poll keyset** the Gateway returns so later votes can be decrypted and attributed. There is no automatic post-game scheduling.
- **FR-013**: System MUST record each poll response against the voter's canonical identity as provided by the Gateway's per-voter vote events, aggregating those events into the current tally by applying each as a replace-by-voter update (a vote change replaces the prior selection; a withdrawal clears it). The system MUST NOT double-count a person who appears under two address forms.
- **FR-014**: When the Gateway requests a poll's keyset to decrypt a vote, the system MUST supply the stored keyset for that poll; if the system has no keyset for the poll (e.g., unknown or replaced), it MUST allow the Gateway to skip that vote without error.
- **FR-028**: When a poll trigger fires (FR-029 / `poll` CLI) but, after the on-demand fetch (FR-003), there is **no confirmed next fixture** (the scraper skipped a "Fixtures to be confirmed" placeholder, yielding none) **or the fetch failed** (club site unreachable), the system MUST post **no** poll and MUST reply in the authorized group explaining why (e.g. "no confirmed next fixture yet" / "couldn't reach the club site"), then wait for the next manual trigger. This human-initiated check replaces the former automatic unconfirmed-fixture guard; the operator decides when a fixture is ready before triggering.
- **FR-029**: System MUST treat a group message whose whole text (case-insensitive, whitespace-trimmed) equals `!postpoll` as a poll-post command, sent by **any** member of the authorized group. On such a message the system MUST re-fetch fixtures (FR-003) and post the next fixture's poll (FR-012), or — if a poll already exists for that fixture slot — replace it (FR-027). The command MUST be intercepted **before** stat extraction so it is never captured as a stat (FR-015). The system MUST be silent in-chat on success and reply only on the problem cases of FR-028. **Caveat (accepted):** because any member may send `!postpoll`, any member can force a replacement that hard-deletes an existing poll and all its recorded votes; this footgun is accepted for MVP simplicity.

#### Stat capture

- **FR-015**: System MUST interpret natural-language messages (delivered via the Gateway's incoming-message notifications) to capture per-player stats: goals, assists, weight direction (`up`/`down`/`same`/`unknown`), and food tracking (`yes`/`no`).
- **FR-016**: System MUST handle various natural-language expressions for goals and assists (e.g., "scored", "2 goals", "got one", "assisted").
- **FR-017**: System MUST attempt stat capture only during the 3-day window following a game; messages outside this window are treated as ordinary chat.
- **FR-018**: System MUST be conservative in stat capture, using confidence scoring (0–100%) and only capturing stats when confidence exceeds 70%, and MUST NOT over-interpret general chat.
- **FR-019**: System MUST attribute captured stats to the canonical identity of the player who sent the message, linked to the relevant game; it MUST accept partial messages and update only the specific fields mentioned (e.g., "2 goals" in one message, "1 assist" in another). Multiple messages from the same player within the 3-day window merge/update their stats for that game. A later message overrides **only the fields it mentions**, including explicit corrections (e.g., after "2 goals, 2 assists", a later "correction 1 goal" sets goals=1 and leaves assists=2 unchanged). This player-driven override is the **only** way stored stats change — there is no captain-side editing (FR-024). WhatsApp message edits/deletes are ignored.
- **FR-020**: System MUST apply defaults only for the initial stat capture when values are not explicitly stated: goals=0, assists=0, weight=unknown, tracking=no; subsequent partial messages update only the fields mentioned without resetting other fields.
- **FR-021**: System MUST capture weight as direction only (`up`/`down`/`same`/`unknown`) and MUST NOT capture weight values, BMI, or other health data.

#### Storage & viewing

- **FR-022**: System MUST store captured stats and poll responses in a database, retained per season.
- **FR-023**: Captain MUST be able to view recorded stats for any game in the current or previous seasons.
- **FR-024**: System MUST NOT provide a captain-side stat-correction/edit command. Stored stats change **only** via a player sending a further message within the 3-day window (a field-level override per FR-019). Captain-driven correction (including for past seasons) is **out of scope** for this MVP.
- **FR-025**: System MUST log all operations with timestamps (fixture checks, polls posted, messages processed, connection-state changes, errors) to provide a full audit trail for debugging and monitoring.
- **FR-030**: System MUST provide a **read-only** way to view recorded poll responses from the CLI, surfaced as a `--show-responses` flag on the `fixtures` command. For each listed fixture that has a poll, the system MUST display every recorded response — the voter's display name (falling back to the canonical identity when no name is stored) and their selected availability option — grouped under that fixture. A listed fixture with no poll, and a poll with no responses, MUST each be shown without error rather than omitted. The flag MUST honour the existing `fixtures` selectors (`--all`, `--season <n>`, `--json`) and MUST NOT change `fixtures` output when it is absent. The view reads only stored data (no WhatsApp/Gateway interaction) and MUST NOT double-count a person who voted under two address forms (one response per canonical identity, per FR-013).

#### Poll replacement

- **FR-026**: When a fixture is rescheduled, replacement is **manual, not automatic**: a human re-sends `!postpoll` (or runs `poll --force`), which re-fetches fixtures and replaces the existing poll via FR-027. The system does **not** automatically detect reschedules or auto-replace polls.
- **FR-027**: When a poll is replaced — triggered by re-sending `!postpoll` (FR-029) or via the `poll --force` CLI — the system MUST hard-delete the previous poll record and cascade-delete all poll responses belonging to it (no orphaned responses, no soft-delete/superseded marker). The system MUST then request deletion of the previous poll message through the Gateway's best-effort delete capability; if the Gateway reports the deletion failed (window passed, message already gone, network failure), the system MUST log a warning with a timestamp and continue with the database deletion and new poll rather than blocking, retrying, or aborting.

### Key Entities

- **Club/Team**: The MAN v FAT club (identified by its `manvfatfootball.com` page URL) and the specific team the captain manages within that club.
- **Season**: A numbered season representing a distinct competition period; historic seasons are retained indefinitely.
- **Game**: A fixture for the team including date, time, opponent, venue, and link to the season.
- **WhatsApp Credentials**: The opaque session-credential snapshot returned by the Gateway and persisted by the MVP so the WhatsApp session resumes without re-pairing.
- **Player Identity**: The canonical identity (provided by the Gateway, reconciling JID/LID address forms) used to attribute poll responses and stats to one person.
- **Poll**: An availability poll posted for a specific fixture; at most one active poll exists per fixture. The MVP stores the poll record together with the **poll keyset** the Gateway returns. Replacing a poll hard-deletes the prior record rather than retaining a superseded copy.
- **Poll Response**: A voter's current selection for a specific poll, keyed by canonical identity; responses are owned by their poll and cascade-deleted when that poll is deleted (no orphaned responses).
- **Stat Record**: Per player identity, per game: goals (integer), assists (integer), weight direction (`up`/`down`/`same`/`unknown`), food tracking (`yes`/`no`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Captain can view all team fixtures for the current season within 5 seconds of requesting them.
- **SC-002**: When `!postpoll` is sent in the authorized group, the system responds within 30 seconds — either posting the poll, or (on no confirmed fixture / fetch failure) posting a problem reply in-chat.
- **SC-003**: 80% of clear stat messages (confidence >70%) are correctly captured during the 3-day window.
- **SC-004**: False-positive rate for stat capture is below 5% (confidence scoring prevents casual-chat misinterpretation).
- **SC-005**: Captain can view stats for any game in under 30 seconds.
- **SC-006**: Season transitions are detected automatically when old fixtures disappear from the club website, with 100% accuracy (no data loss or cross-season contamination).
- **SC-007**: System maintains 99.9% data integrity across multiple seasons (no loss of historical stats or poll responses).
- **SC-008**: Poll-response capture rate is 100% (every vote the Gateway emits is recorded against the correct person, with no double-counting across address forms).
- **SC-009**: System reduces the captain's manual stat-tracking time by at least 70% compared to manual spreadsheet entry.
- **SC-010**: Full test suite completes in under 10 seconds to enable rapid TDD cycles and fast CI/CD feedback.
- **SC-011**: No MVP source file imports or references the underlying WhatsApp protocol library; all WhatsApp behaviour is reached only through the Gateway's public interface (verifiable by inspection / a guard test).
- **SC-012**: Captain can view availability responses across a season's polls (`fixtures --show-responses`) within 5 seconds of requesting them (consistent with SC-001), with every recorded vote shown against the correct person and no double-counting (SC-008).

## Assumptions

- The MAN v FAT Football website structure remains consistent enough to scrape fixture information reliably with static HTML parsing (no JavaScript rendering required). Dynamic/headless-browser scraping (e.g., Playwright) is **excluded from this MVP entirely** — it was removed in the earlier attempt as too complex; the MVP relies only on static parsing (Axios + Cheerio).
- The WhatsApp Gateway library (spec 002, `src/whatsapp-gateway/`) is complete, tested, and available to the MVP as the single integration point for all WhatsApp behaviour. The MVP depends on the Gateway's public interface (connect / force re-auth / list groups / send & receive messages / send poll / read votes / delete message, plus credential-snapshot and poll-keyset callbacks and canonical identities) exactly as documented in its interface contract.
- Concerns owned by the Gateway and therefore **out of scope for this spec**: QR pairing/generation (the Gateway surfaces the raw QR value only), forced re-authentication, connection lifecycle and reconnection/backoff, single-group restriction, group listing, poll-vote decryption, JID/LID identity canonicalization, outbound rate-limiting, and best-effort deletion semantics. **Owned by the MVP (in scope):** rendering the surfaced QR value (terminal + image file) and persisting the opaque credential snapshot in the MVP database.
- The Gateway's QR subscription surfaces the raw QR *value* to the consumer; if the Gateway library currently also prints the QR to its own console, that is a Gateway-side detail the MVP does not rely on — the MVP renders from the surfaced value. (Any such console output in the Gateway is tracked separately under spec 002, not here.)
- The fixture/scraping, season-transition, persistence, stat-parsing, and CLI research and design from the earlier MVP attempt (`001-mvf-captain-stats`) are reused as the baseline for the non-WhatsApp domain; only the WhatsApp-facing design is reworked onto the Gateway.
- The tool runs on a server as a single deployment instance using the operator's (captain's) WhatsApp credentials; the operator has physical access to their phone for the initial QR scan.
- Players use the authorized WhatsApp group for team communication and stat reporting; the team plays a regular weekly schedule with predictable fixture patterns.
- Internet connectivity is generally available for periodic fixture checks and WhatsApp monitoring.
- The captain is authorized to monitor the WhatsApp group and collect player stats (no consent mechanism needed for this personal project).
- Weight direction data is sufficient; actual weight values or BMI are not needed.
- Stat-capture accuracy of 80% is acceptable given the conservative approach (70% confidence threshold) and the player-driven correction path (a follow-up message overrides earlier values, FR-019); natural-language processing can distinguish stat reports from casual chat with reasonable accuracy using confidence scoring.
- Fixture data on the club website is accurate and updated by the league administrators; on-demand fetches (at `!postpoll`/`sync`/`fixtures`) are sufficient, since a human triggers a poll only once they can see the next fixture is confirmed.
- The 3-day post-game window is sufficient for players to report stats; a human triggering `!postpoll` the day after a game aligns with typical team coordination timelines.
- Database storage can scale to multiple seasons for a single team (estimated: 20–30 games/season, 10–15 players/team, 5+ seasons).
- Initial WhatsApp setup requires a one-time `captain-stats connect` run to authenticate (QR scan) and identify the target group; the operator sets `AUTHORIZED_GROUP_ID` in `.env` before starting the daemon. The `connect` command and the daemon share the same persisted Gateway credential snapshot, so no duplicate QR scan is needed on first daemon start.
- Timezone handling defaults to UK time since MAN v FAT Football is UK-based.
- Tests use a real **in-memory** database (not an on-disk test file) for accurate behaviour validation at speed; external dependencies are mocked at their **service boundaries only** — a fake fixture scraper and a fake WhatsApp Gateway (both implementing the same interfaces the production code uses). No mocking of library internals (axios, cheerio, or the protocol library) appears anywhere in the test suite. Interactive WhatsApp paths (QR pairing, live votes) are validated through the Gateway's own manual entry points, not this suite.
- Retry with exponential backoff for the fixture scraper remains a shared MVP utility; WhatsApp rate-limiting and reconnection are owned by the Gateway and are no longer MVP concerns.
- Removing the earlier attempt's direct-protocol WhatsApp implementation and cutting the MVP over to the Gateway is the **foundational, in-scope first step** of this feature (it was deliberately deferred out of spec 002). The earlier `001-mvf-captain-stats` spec is superseded by this feature.
