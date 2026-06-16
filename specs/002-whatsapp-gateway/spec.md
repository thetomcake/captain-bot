# Feature Specification: Standalone WhatsApp Gateway Library

**Feature Branch**: `002-whatsapp-gateway`

**Created**: 2026-06-13

**Status**: Draft

**Input**: User description: "An entirely new side spec to build our own independent WhatsApp integration module that moves all the WhatsApp/Baileys complexity to a higher level so the MVP can focus on its own domain. The library must perform: authentication (and forced re-authentication), connection & reconnection handling (reusing the reconnect/disconnect logic already identified), listing groups, sending messages, receiving and handling messages, sending polls, handling poll votes, deleting messages/polls, encryption/decryption, limiting handling to specific groups, and JID/LID handling. It must be simple to use and include in the current MVP, extremely well written, easy to understand, tested, and usable as a standalone library within the project. It must not touch the current MVP implementation, and must be independently testable manually via separate CLI entry points for each action (one entry point per action, no shared CLI/argument-parsing layer)."

## Overview

The MVP currently talks to WhatsApp by calling the low-level WhatsApp Web protocol library (Baileys) directly. That low-level surface is large, fragile, and version-sensitive, and its complexity has leaked into the MVP, producing recurring connection, poll-vote, and identity bugs. This feature delivers a **self-contained WhatsApp Gateway library inside the project** that absorbs all of that complexity behind a small, stable, well-documented, well-tested interface. The MVP (and any future feature) consumes the gateway through a handful of clear operations and never touches the protocol library again.

The library is delivered **alongside, not inside, the existing MVP code** — it does not modify or depend on current MVP modules. It is exercised on its own through a set of **single-purpose manual entry points** (one per action), so a human operator can validate each behaviour against a real WhatsApp account without any shared command-line or argument-parsing machinery.

## Glossary

- **Gateway**: the new standalone WhatsApp integration library this spec defines.
- **Consumer**: any code that uses the Gateway (initially the MVP; during validation, the manual entry points).
- **Protocol library**: the underlying third-party WhatsApp Web library the Gateway wraps.
- **Authorized group**: a WhatsApp group the Gateway is explicitly configured to act on; activity from any other chat is ignored.
- **Identity**: the durable "who" behind a sender or voter, which WhatsApp may surface in more than one address form (see JID/LID below).
- **JID / LID**: the two address forms WhatsApp uses for the same person — a phone-number-based address and a privacy-preserving "linked" address. The same human can appear as either depending on group settings.
- **Poll keyset**: the per-poll data the consumer stores (decryption secret + options + ids), returned by `sendPoll` and supplied back so a later vote can be decrypted; the Gateway holds no durable poll state.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Authenticate and stay connected (Priority: P1)

A consumer needs the Gateway to establish and maintain a logged-in WhatsApp session. On first use it must surface a QR code for the operator to scan; on subsequent uses it must resume the saved session without a new scan. It must keep the session alive across transient disconnects automatically, and it must let the operator deliberately force a fresh login when the session is broken or the wrong account is linked.

**Why this priority**: Nothing else in the Gateway works without a live session. This is the foundation and the first independently demonstrable slice.

**Independent Test**: Run the `connect` entry point against a real account: a QR appears, scanning it reaches a "connected" state, and re-running it reconnects with no QR. Kill the network briefly and confirm it recovers on its own. Run the `force-reauth` entry point and confirm the next connect requires a new QR.

**Acceptance Scenarios**:

1. **Given** no saved session, **When** the consumer connects, **Then** the Gateway emits a QR code and reaches a "connected" state only after the code is scanned.
2. **Given** a previously saved session, **When** the consumer connects, **Then** the Gateway reaches "connected" without emitting a QR code.
3. **Given** a successful first pairing, **When** the protocol forces an immediate post-pairing reconnect handshake, **Then** the Gateway completes the handshake transparently and the consumer still observes a single successful "connected" outcome (bounded so it fails loudly rather than looping forever).
4. **Given** an active session, **When** the connection drops for a transient reason, **Then** the Gateway automatically attempts to reconnect on a defined backoff schedule and returns to "connected" when the network recovers, without consumer intervention.
5. **Given** an active session, **When** the session is terminated for a non-recoverable reason (logged out, account unlinked, forbidden, or irrecoverable session state), **Then** the Gateway stops retrying, reports a distinct terminal state, and does not silently loop.
6. **Given** any session, **When** the consumer requests forced re-authentication, **Then** the Gateway logs out best-effort, clears all stored session/credential state, and the next connect produces a fresh QR.

---

### User Story 2 - Send and receive messages within the authorized group (Priority: P2)

A consumer needs to send text messages to the authorized group and to be notified of incoming messages from that group, with the sender's identity and message text available. Activity from every other chat must be ignored.

**Why this priority**: Two-way messaging in a single trusted group is the core capability the MVP is built on, and it is the second self-contained slice.

**Independent Test**: With the `listen` entry point running, send a message in the authorized group from a phone and confirm it is reported with correct text and sender; send a message in a different chat and confirm it is NOT reported. Use the `send-message` entry point and confirm the text appears in the authorized group.

**Acceptance Scenarios**:

1. **Given** a connected session, **When** the consumer sends text to the authorized group, **Then** the message appears in that group and the Gateway returns a reference (message identifier) for it.
2. **Given** a connected session, **When** a new message arrives in the authorized group, **Then** the Gateway notifies the consumer with the message text, sender identity, timestamp, and message identifier.
3. **Given** a connected session, **When** a message arrives in any chat other than the authorized group, **Then** the Gateway does not notify the consumer.
4. **Given** an incoming message that the Gateway's own **programmatic** activity echoes back, or history replayed on resync (rather than a genuinely new live message), **When** it is observed, **Then** the Gateway does not misreport it as new inbound user activity. (A message the operator sends manually from their own phone IS genuine new inbound activity and is reported — the operator is a participant.)
5. **Given** outbound sends in quick succession, **When** the consumer sends multiple messages, **Then** the Gateway paces them within a conservative rate limit to reduce ban risk.

---

### User Story 3 - Post polls and capture votes reliably (Priority: P3)

A consumer needs to post a native WhatsApp poll to the authorized group and then receive accurate per-voter events for who voted for which option — which it aggregates into a current tally — with each voter resolved to a single stable identity even when WhatsApp presents that person under different address forms.

**Why this priority**: Polls and their vote results are the hardest, most failure-prone capability and the original motivation for the rebuild. It depends on P1 (connection) and P2 (group messaging) and is the slice that most needs to be provably correct.

**Independent Test**: Use the `send-poll` entry point to post a poll to the authorized group, then run the `watch-votes` entry point; cast votes from one or more phones (including changing a vote) and confirm the reported tally matches reality, attributes each vote to the correct person, and never double-counts a person who appears under two address forms.

**Acceptance Scenarios**:

1. **Given** a connected session, **When** the consumer posts a poll with a question and 2–12 options, **Then** the poll appears in the authorized group and `sendPoll` returns both a message reference and a **poll keyset** (decryption secret + options) for the consumer to store.
2. **Given** a posted poll whose keyset the consumer has stored, **When** a group member votes, **Then** the Gateway requests the keyset from the consumer, decrypts the vote, and emits a per-voter event with the voter's identity and their current selection.
3. **Given** a member who changes or withdraws their vote, **When** the new selection arrives, **Then** the emitted event carries the member's full current selection (a withdrawal being an empty selection), so the consumer can replace that voter's prior entry.
4. **Given** a poll in a group that addresses members by the privacy-preserving (LID) form, **When** votes arrive, **Then** the Gateway still decrypts and attributes them correctly rather than silently dropping them.
5. **Given** a voter who appears as one address form in chat and another in votes, **When** their vote is processed, **Then** the Gateway resolves both forms to the same canonical identity so the consumer does not double-count them.
6. **Given** a vote for a poll whose keyset the consumer cannot provide (e.g., unknown or expired), **When** the vote arrives, **Then** the Gateway skips decryption for that vote without error.

---

### User Story 4 - Discover available groups (Priority: P4)

A consumer (or operator during setup) needs to list every group the logged-in account belongs to, with each group's display name and stable identifier, so the correct authorized group can be chosen and configured.

**Why this priority**: Needed once, for setup/onboarding; valuable but not on the critical runtime path.

**Independent Test**: Run the `list-groups` entry point against a connected account and confirm the output lists each group with a human-readable name and a stable identifier.

**Acceptance Scenarios**:

1. **Given** a connected session, **When** the consumer requests the group list, **Then** the Gateway returns every group the account participates in, each with a display name and stable identifier.
2. **Given** an account in no groups, **When** the consumer requests the group list, **Then** the Gateway returns an empty result without error.

---

### User Story 5 - Delete a message or poll the Gateway sent (Priority: P5)

A consumer needs to remove a message or poll the Gateway previously posted to the authorized group (for example, to replace a superseded poll). Deletion is best-effort: when WhatsApp will not allow it, the consumer is told clearly and the operation does not block or crash.

**Why this priority**: Supports the MVP's poll-replacement behaviour but is the least critical and depends on send (P2/P3) existing first.

**Independent Test**: Use `send-message` (or `send-poll`) to post something, capture its reference, then use the `delete-message` entry point with that reference and confirm it disappears from the group. Attempt to delete something outside the allowed deletion window and confirm a clear, non-fatal failure is reported.

**Acceptance Scenarios**:

1. **Given** a message the Gateway sent and a valid reference to it, **When** the consumer requests deletion, **Then** the message is removed for everyone in the group.
2. **Given** a deletion that WhatsApp rejects (window expired, message already gone, or network failure), **When** the consumer requests deletion, **Then** the Gateway reports the failure clearly and continues without throwing or blocking.

---

### Edge Cases

- **Post-pairing forced reconnect**: the protocol deliberately closes the socket immediately after a first successful pairing and expects an instant reconnect; the Gateway must treat this as an expected handshake step, not an error, and must bound the retries so a genuine restart loop fails loudly.
- **Recoverable vs terminal disconnects**: the Gateway must distinguish reasons it should reconnect from (transient close, connection lost, timed out, restart-required, service unavailable) versus reasons it must stop and surface (logged out, account unlinked/forbidden, multi-device mismatch, irrecoverable session) — including cases where two distinct reasons share the same status code and cannot be told apart by code alone.
- **Replayed-message noise on reconnect**: when reconnecting after being offline, the protocol may re-deliver buffered messages, producing benign duplicate-counter warnings during sync; the Gateway must not crash or treat this as fatal, and must only treat it as a real problem if it persists on genuinely new live messages.
- **Re-delivery of a live message (decrypt-retry / session re-establishment)**: a decrypt failure on a group message triggers a retry-receipt and the participant's Signal session may be torn down and rebuilt; the protocol can then re-emit the *same* live (`notify`) message, and the re-delivered copy may even resolve to a different address form for the same person. The Gateway must dispatch such a message to consumer handlers at most once (FR-034), so a single `!postpoll`-style command cannot fire its handler twice (which previously posted two polls and tripped a `UNIQUE` constraint downstream).
- **Poll-vote decryption is version-sensitive and storage-driven**: automatic poll-vote handling differs between protocol-library versions and is disabled in the pinned version, so the Gateway decrypts votes itself; because it persists nothing durably, it obtains the per-poll decryption secret from its in-session memory of the poll (when still cached) or from the consumer (returned by `sendPoll`, supplied back via a resolver). A vote whose secret is available from neither source is skipped, not errored.
- **Tally is not durable in the Gateway**: the Gateway emits per-voter vote events but keeps no durable cumulative tally; after a restart it only emits events for votes seen since restart, so the consumer's stored aggregate (built from per-voter events) is the source of truth.
- **Identity correlation (JID/LID)**: the same person can appear under two address forms across messages and votes; the Gateway must normalize to one canonical identity wherever it compares or keys by person, and must never report the same person twice.
- **Unauthorized chats**: messages, votes, and events from any chat other than the configured authorized group(s) must be ignored entirely.
- **Operations before connection**: invoking send/poll/delete/list before the session is connected must fail with a clear error rather than undefined behaviour.
- **Deletion window**: deletion is only possible within WhatsApp's allowed window and (for others' messages) with sufficient privileges; outside those, deletion is a reported, non-fatal failure.
- **Poll option bounds**: posting a poll with fewer than 2 or more than 12 options must be rejected before sending.

## Requirements *(mandatory)*

### Functional Requirements

#### Packaging & integration

- **FR-001**: The Gateway MUST be a self-contained module within the project that can be imported and used by the MVP through a single, small, documented interface, without the consumer importing or referencing the underlying protocol library directly.
- **FR-002**: The Gateway MUST NOT modify, depend on, or be coupled to the current MVP implementation; it must be developed and testable in isolation. (The MVP's later adoption of the Gateway is out of scope for this spec.)
- **FR-003**: The Gateway MUST expose its capabilities as a clear, stable interface (a small set of operations and event/notification subscriptions) that hides all protocol-library types and quirks from the consumer.
- **FR-004**: The Gateway MUST be exercisable through **separate single-purpose manual entry points — one per action** (at minimum: connect, force-reauth, list-groups, send-message, listen, send-poll, watch-votes, delete-message) — with no shared command-line framework or argument-parsing layer; each entry point performs exactly one action using inline configuration.

#### Authentication & session

- **FR-005**: The Gateway MUST authenticate to WhatsApp via QR-code pairing on first use and MUST surface the QR to the consumer for display.
- **FR-006**: The Gateway MUST persist session credentials so that subsequent connections resume the existing session without re-scanning a QR code.
- **FR-007**: The Gateway MUST provide a forced re-authentication operation that logs out (best-effort), clears all persisted session and credential state, and causes the next connection to require a fresh QR scan.
- **FR-008**: The Gateway MUST persist session state through a storage mechanism that is independent of the MVP's own data, so that running the Gateway standalone does not require any MVP database or schema.

#### Connection & reconnection

- **FR-009**: The Gateway MUST report a clear connection lifecycle to the consumer (at least: connecting, connected, disconnected/closed, and a distinct terminal/logged-out state).
- **FR-010**: The Gateway MUST automatically handle the protocol's post-pairing forced-reconnect handshake transparently, bounded by a maximum number of attempts so a stuck restart loop fails with a clear error.
- **FR-011**: The Gateway MUST automatically reconnect on recoverable disconnects using a defined backoff schedule, and MUST stop and surface a terminal state on non-recoverable disconnects, correctly classifying each disconnect reason (including reasons that share a status code).
- **FR-012**: The Gateway MUST keep its persisted credentials current as the protocol updates them during a session, so that a later resume succeeds.

#### Messaging

- **FR-013**: The Gateway MUST send text messages to a configured group and return a reference (message identifier) for each sent message.
- **FR-014**: The Gateway MUST notify the consumer of incoming messages, providing message text, sender identity, timestamp, and message identifier.
- **FR-015**: The Gateway MUST distinguish genuinely new inbound messages from echoes of its own activity / history backfill, and MUST only report the former as new inbound activity. **Clarification:** the Gateway is linked to the operator's own account, so the operator is a **participant** — messages they send manually (e.g. from their own phone) ARE genuine new inbound activity and MUST be reported, even though they carry the account's own identity. "Echoes of its own activity" means the Gateway's **programmatic** sends (`sendMessage`/`sendPoll`) and resync history backfill — both of which the protocol delivers as `append`-type events — and these MUST NOT be reported. Dispatch is therefore gated on the live/history nature of the event, not on whether it is from the linked account.
- **FR-016**: The Gateway MUST pace outbound sends within a conservative, configurable rate limit to reduce account-ban risk.

#### Group restriction

- **FR-017**: The Gateway MUST act only on one or more explicitly configured authorized group(s) and MUST ignore all messages, votes, and events originating from any other chat.
- **FR-018**: The Gateway MUST validate that a target chat is a group (not a direct, broadcast, or other chat type) before acting on it.

#### Group listing

- **FR-019**: The Gateway MUST list all groups the authenticated account participates in, returning each group's display name and stable identifier, and MUST return an empty result (not an error) when there are none.

#### Polls & votes

- **FR-020**: The Gateway MUST post a native WhatsApp poll to a configured group given a question and a set of options (2–12), posting it as a single-choice poll (multi-select is out of scope for now), and MUST return a reference for the poll together with its poll keyset (FR-021).
- **FR-021**: Because the Gateway persists nothing durably, `sendPoll` MUST return a **poll keyset** — the decryption secret plus the poll's options (and ids) — for the consumer to store. To decrypt a later vote the Gateway resolves the poll's secret from its own **in-session memory** of the poll-creation message when still available, and otherwise MUST request the keyset from the consumer via a resolver callback keyed by the poll reference; if neither source yields the secret, the Gateway MUST skip decryption for that vote without error (best-effort, never crash). Only the consumer-stored keyset survives a restart, so it remains the source of truth.
- **FR-022**: For each successfully decrypted vote, the Gateway MUST emit a per-voter event giving the voter (resolved to a single canonical identity) and the voter's full current selection (option names). The Gateway does NOT maintain a durable cumulative tally; the consumer aggregates per-voter events into a running result.
- **FR-023**: Each emitted vote event MUST represent the voter's full current selection at that moment (a vote change replaces the prior selection; a withdrawal is an empty selection), so the consumer applies it as a replace-by-voter update rather than an increment.
- **FR-024**: The Gateway MUST correctly handle and attribute poll votes in groups that use the privacy-preserving (LID) addressing form, rather than dropping or misattributing them.

#### Identity (JID/LID)

- **FR-025**: The Gateway MUST normalize sender and voter identities to a single canonical form so that the same person presented under different address forms (phone-number form vs privacy-preserving form, with or without device suffixes) is treated as one identity.
- **FR-026**: The Gateway MUST never report or count the same person more than once across its message and poll outputs due to differing address forms.

#### Deletion

- **FR-027**: The Gateway MUST delete (revoke for everyone) a message or poll it previously sent, given a valid reference.
- **FR-028**: The Gateway MUST treat deletion as best-effort: when WhatsApp rejects it (window expired, message gone, insufficient privilege, or network failure), the Gateway MUST report a clear, non-fatal failure and continue.

#### Encryption / decryption

- **FR-029**: The Gateway MUST rely on the protocol library's automatic end-to-end encryption/decryption for ordinary messages, and MUST additionally perform any vote decryption the pinned protocol version does not perform automatically (see FR-021/FR-022).
- **FR-030**: The Gateway MUST tolerate benign cryptographic-counter warnings emitted during offline re-sync without failing, while still allowing genuinely persistent decryption failures on new live messages to surface.
- **FR-034**: The Gateway MUST dispatch each distinct inbound message to a consumer handler **at most once**, even when the protocol re-delivers the same message (e.g. after a decrypt-failure retry-receipt or a session re-establishment). It MUST deduplicate by the message's stable reference (chat + message id) across both the incoming-message (FR-014) and poll-vote (FR-022) dispatch paths, so a single user action that the protocol re-delivers does not fire a handler twice. Deduplication is best-effort and bounded (it covers a recent window of messages, sufficient to absorb the burst-style re-deliveries that re-sync/retry produce); a re-delivery so far separated that it falls outside the window MAY be dispatched again. A message lacking a usable reference (no id) is dispatched as normal. This complements FR-015 (which gates *live vs history/echo*) by additionally guarding against duplicate delivery of the *same live* message.

#### Correctness, documentation & testing discipline

- **FR-031**: The Gateway's behaviour MUST conform exactly to the official documentation **for the specific pinned version** of the protocol library in use; where the installed version's actual behaviour differs from general documentation, the **installed version's verified behaviour governs**. Implementation MUST NOT rely on assumed, remembered, or invented APIs or behaviours.
- **FR-032**: The Gateway MUST be documented so a developer unfamiliar with the protocol library can understand and use it from the interface and examples alone.
- **FR-033**: The Gateway MUST be covered by an automated test suite that validates its behaviour at its own interface boundary (not by reaching into protocol-library internals), so the suite runs fast and without a live WhatsApp connection; interactive, connection-dependent behaviours (QR pairing, live votes) are validated via the manual entry points instead.

### Key Entities *(include if feature involves data)*

- **Gateway Client**: the single object a consumer creates and uses; owns configuration (authorized group(s), rate limit, session storage) and exposes all operations and event subscriptions.
- **Session / Credentials**: the persisted authentication state that lets a connection resume without re-scanning; created on first pairing, cleared on forced re-auth.
- **Connection State**: the current lifecycle status of the link to WhatsApp (connecting / connected / closed / terminal).
- **Group**: a WhatsApp group, identified by a stable identifier and a display name (with its addressing mode — phone-number or privacy-preserving — surfaced to help judge vote attribution); some are authorized, the rest are ignored.
- **Message**: an item sent to or received from a group — text, sender identity, timestamp, and a stable reference used for later deletion.
- **Poll**: a question with 2–12 options posted to a group. Posting yields a **Poll Keyset** the consumer stores; the Gateway keeps no durable poll state.
- **Poll Keyset**: the data the consumer persists for a poll (decryption secret + options + ids) and supplies back so a later vote can be decrypted; returned by `sendPoll`.
- **Vote**: a per-voter event — a voter (canonical identity) and their full current selection of option names at that moment. The consumer aggregates votes into a running result.
- **Identity**: the canonical representation of a person, reconciling the multiple address forms (JID/LID, with/without device suffix) WhatsApp may use for the same human; it may also carry an optional best-effort display hint (e.g., push name).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A consumer can perform any supported action (connect, list groups, send a message, receive messages, post a poll, read poll votes, delete a message, force re-auth) using only the Gateway's documented interface, without referencing the underlying protocol library — verified by the manual entry points each importing only the Gateway.
- **SC-002**: First-time authentication via QR succeeds, and every subsequent connection resumes the session with no QR scan, in 100% of attempts where the session has not been logged out.
- **SC-003**: After a transient disconnect, the Gateway returns to a connected state automatically (no operator action) on the defined backoff schedule; after a terminal disconnect it stops retrying and reports the terminal state — observed correctly for every reason class.
- **SC-004**: 100% of messages and votes originating outside the configured authorized group(s) are ignored (zero leakage), and 100% of qualifying inbound messages from the authorized group are reported.
- **SC-005**: For a poll with real voters, the per-voter events the Gateway emits (and which the consumer aggregates) match the actual votes, including vote changes/withdrawals, and attribute every vote to the correct person — including in privacy-preserving (LID) groups — with zero double-counting of a person appearing under two address forms.
- **SC-006**: Deletion of a Gateway-sent message succeeds within the allowed window, and every rejected deletion produces a clear, non-fatal report rather than a crash or hang.
- **SC-007**: The automated test suite validates Gateway behaviour at its own interface boundary, runs without a live WhatsApp connection, and completes quickly enough to support rapid iteration (consistent with the project's existing fast-suite expectations).
- **SC-008**: A developer who has not used the protocol library before can integrate the Gateway into a new consumer using only its documentation and examples, with no need to read protocol-library docs.

## Assumptions

- **Engine choice is settled**: the Gateway wraps the project's existing unofficial WhatsApp Web protocol library (Baileys). Research determined no third-party wrapper or the official WhatsApp Cloud API is viable for this use case (the official API supports neither native polls/vote-readback nor monitoring an existing group), so building a thin in-house wrapper is the chosen path. The associated WhatsApp Terms-of-Service / account-ban risk is accepted, as it already is for the current MVP.
- **Pinned-version fidelity**: the protocol library version is pinned, and all behaviour must be implemented and verified against that exact version's real behaviour and its official documentation for that version. Documentation describing intended behaviour that the installed version disables or changes must not be relied upon. (Concretely: automatic poll-vote decryption is disabled in the currently installed version, so the Gateway must perform vote decryption itself and verify this against the pinned version at implementation time.)
- **Reuse of existing connection logic**: the reconnect/disconnect classification, the bounded post-pairing restart handshake, and the rate-limiting approach already proven in the current MVP are carried into the Gateway as the baseline behaviour, hardened and fully covered by the new interface.
- **Standalone session storage**: the Gateway persists its session through its own storage abstraction with a simple default suitable for standalone manual testing, independent of the MVP's database, so it can run in isolation; a consumer may supply an alternative store.
- **Manual validation for interactive paths**: QR pairing, live message receipt, and live poll voting require a real device and account and are validated through the manual per-action entry points, not the automated suite — consistent with the project's constitution excluding interactive hardware from automated tests.
- **Single team / low volume**: the Gateway targets a single account monitoring one (configurable to a few) group(s) at low message volume; it is not designed for multi-tenant or high-throughput use.
- **Configuration is inline for entry points**: because each manual entry point is single-purpose with no argument parser, its inputs (e.g., target group identifier, poll text) are provided via inline constants or environment values rather than command-line arguments.
- **Removal of direct protocol usage from the MVP is deferred**: cutting the MVP over to the Gateway and deleting the MVP's direct protocol-library usage is explicitly out of scope here and will be handled separately so history is not polluted with code that is later removed.
