# Feature Specification: Offline Catch-Up on Reconnect

**Feature Branch**: `004-offline-catch-up`

**Created**: 2026-06-16

**Status**: Draft

**Input**: User description: "Alter the WhatsApp Gateway (feature 002) so that messages and poll votes missed while the Gateway is offline (e.g. an internet outage that takes the daemon down) are caught up and processed on reconnect, instead of being silently dropped."

## Context & Problem *(informative)*

The WhatsApp Gateway (feature 002) is a long-running listener. When its connection drops — most commonly an internet outage that takes the daemon down — group members keep sending messages and changing their poll votes. When the Gateway reconnects, WhatsApp **does** re-deliver everything that was missed during the outage (this is confirmed behaviour, not a hoped-for one). However, the Gateway currently **discards all of it**: the catch-up traffic is delivered tagged as "not live" (an `append`-type delivery, set because each item carries an `offline` marker), and the Gateway dispatches only "live" (`notify`-type) items to its consumer. The discard happens before the authorized-group check and before poll-vote handling, so missed messages and missed/changed votes never reach the MVP.

The original reason for dropping the "not live" stream was sound: it also carries **echoes of the Gateway's own programmatic sends** (the messages and polls the Gateway itself posted) and bulk history backfill, neither of which should be re-reported as new inbound user activity. The problem is that the same stream **also** carries the legitimate outage catch-up, so the existing filter throws out the catch-up along with the echoes.

Since feature 002 was written, the Gateway gained an at-most-once dispatch guard (feature 003 Phase 9, FR-034): an in-memory store that "claims" each `(chat, message-id)` exactly once so a re-delivered message is never dispatched twice. This guard is the missing piece that makes it safe to stop blanket-dropping the catch-up stream: the Gateway's own sends can be claimed at send time so their later echoes are recognised and suppressed, leaving the genuine catch-up to flow through.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Missed/changed poll votes are recovered after an outage (Priority: P1)

A poll is live in the authorized group. The daemon loses internet and goes down. While it is down, members cast new votes and change existing votes. The internet returns and the daemon reconnects. The operator expects the poll tally to reflect the votes cast during the outage, without anyone having to re-vote.

**Why this priority**: This is the reported defect and the primary motivation for the feature. Poll tallies driving team selection are wrong after any outage, silently, with no indication to the operator that data was lost.

**Independent Test**: With a live poll, take the Gateway offline, change/add votes from another account, bring the Gateway back online, and confirm the recovered votes are decrypted and applied to the tally — producing the same result as if the Gateway had never been offline.

**Acceptance Scenarios**:

1. **Given** a live poll in the authorized group and the Gateway offline, **When** a member casts a new vote during the outage and the Gateway reconnects, **Then** that vote is decrypted, attributed to the voter, and reflected in the tally.
2. **Given** a member who voted before the outage, **When** they change their vote during the outage and the Gateway reconnects, **Then** the changed vote replaces their previous selection in the tally (last-write-per-voter).
3. **Given** votes recovered on reconnect, **When** the same reconnect re-delivers an item the Gateway already processed, **Then** that item is not applied twice (at-most-once preserved).

---

### User Story 2 - Missed group messages are recovered after an outage (Priority: P2)

While the daemon is offline, members post messages in the authorized group — including the stat-capture and command messages the MVP reacts to. On reconnect, the operator expects those messages to be processed as if they had arrived live, so no group activity during an outage is lost.

**Why this priority**: Completes the catch-up guarantee so the Gateway's "I am monitoring this group" promise holds across outages for all inbound activity, not just votes. Lower than P1 because the reported, highest-impact loss is votes; message catch-up is the same mechanism applied to the text path.

**Independent Test**: Take the Gateway offline, post messages in the authorized group from another account, bring the Gateway back online, and confirm each missed message is dispatched to the consumer exactly once with correct sender, text, and timestamp.

**Acceptance Scenarios**:

1. **Given** the Gateway offline, **When** a member posts a message in the authorized group and the Gateway reconnects, **Then** the message is dispatched to the consumer as inbound activity with its original sender, text, and timestamp.
2. **Given** messages recovered on reconnect, **When** any of them is an echo of a message the Gateway itself sent before the outage, **Then** it is NOT reported as new inbound activity.
3. **Given** a message from an unauthorized chat that is part of the reconnect catch-up, **When** it is delivered, **Then** it is NOT dispatched to the consumer (authorized-group-only preserved).

---

### User Story 3 - The Gateway's own sends are never mistaken for new inbound activity (Priority: P1)

Independent of any outage, the Gateway routinely posts messages and polls. WhatsApp echoes these back to the Gateway's own connection. The consumer must never see the Gateway's own programmatic send re-reported as a new inbound message or as a new vote, whether the echo arrives live or as part of a reconnect catch-up.

**Why this priority**: This is the invariant that made the original blanket-drop necessary; relaxing the drop (US1/US2) is only safe if this protection is explicitly guaranteed by another mechanism. It is a correctness precondition for US1 and US2, hence P1.

**Independent Test**: Send a message and a poll via the Gateway, then trigger their echo (live, and via a reconnect) and confirm neither is dispatched to the consumer as new inbound activity, while a genuine member message in the same group still is.

**Acceptance Scenarios**:

1. **Given** the Gateway has sent a message, **When** WhatsApp echoes that message back (live or on reconnect), **Then** the echo is suppressed and not dispatched as new inbound activity.
2. **Given** the Gateway has posted a poll, **When** the poll-creation echo returns, **Then** it is not dispatched as an inbound message.
3. **Given** a member sends a message manually from the operator's own linked account (a genuine participant action), **When** it arrives, **Then** it IS dispatched as new inbound activity (it is not a programmatic-send echo).

---

### Edge Cases

- **Long outage / large backlog**: a multi-hour outage produces a large catch-up batch on reconnect; every authorized-group item in it must be processed (subject to whatever the server actually retained — see Assumptions), without the Gateway crashing or duplicating.
- **Benign replay noise**: the catch-up batch triggers the known benign cryptographic-counter warnings during re-sync; these MUST remain non-fatal (existing FR-030 behaviour) and MUST NOT be confused with a real decrypt failure on live traffic.
- **Vote with no recoverable poll secret**: a recovered vote whose poll the Gateway can no longer key (no durable keyset) is skipped without error, exactly as a live unkeyable vote is today.
- **Re-delivery window**: a re-delivered item that arrives so far separated in time that it falls outside the at-most-once dedup window MAY be dispatched again (best-effort dedup, consistent with FR-034); this MUST NOT cause a hard failure.
- **Withdrawn vote during outage**: a member who clears their selection during the outage produces an empty selection on recovery; the tally must reflect the withdrawal.
- **Reconnect that is NOT preceded by an outage** (e.g. the expected post-pairing handshake): must not change behaviour or replay history inappropriately.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Gateway MUST process catch-up traffic delivered on reconnect (the items WhatsApp re-delivers because they arrived while the Gateway was offline) as genuine inbound activity, rather than discarding it as "not live".
- **FR-002**: Catch-up processing MUST cover BOTH poll votes (so a vote cast or changed during an outage updates the tally) AND text messages (so stat-capture and command messages posted during an outage are dispatched to the consumer).
- **FR-003**: The Gateway MUST continue to dispatch each distinct inbound item to the consumer **at most once**, including across the reconnect catch-up, reusing the existing `(chat, message-id)` at-most-once guard (FR-034). Recovering missed traffic MUST NOT reintroduce double-dispatch.
- **FR-004**: The Gateway MUST NOT report echoes of its **own programmatic sends** (messages and polls it posted) as new inbound activity, whether the echo arrives live or as part of a reconnect catch-up. The Gateway MUST mark each message it sends as already-accounted-for at send time, so the subsequent echo is recognised and suppressed by the at-most-once guard.
- **FR-005**: The Gateway MUST preserve authorized-group-only dispatch (zero cross-chat leakage): catch-up items from any chat other than the authorized group MUST NOT be dispatched to the consumer. This single authorization chokepoint MUST continue to apply to both the message and poll-vote paths.
- **FR-006**: A message the operator sends **manually** from their own linked account MUST still be reported as genuine new inbound activity (the operator is a participant) — it MUST NOT be suppressed as a programmatic-send echo.
- **FR-007**: Poll votes recovered on reconnect MUST be decrypted and attributed using the existing poll-vote decryption flow, including the durable consumer-keyset fallback that survives restarts; a recovered vote that cannot be keyed MUST be skipped without error.
- **FR-008**: Recovered poll votes MUST follow the existing per-voter, last-write-wins semantics so that a vote changed during an outage replaces that voter's prior selection and a cleared selection registers as a withdrawal.
- **FR-009**: The Gateway MUST remain resilient to the benign cryptographic-counter / replay warnings emitted during reconnect re-sync (existing FR-030 tolerance), and MUST NOT treat them as fatal while still surfacing genuinely persistent decrypt failures on live traffic.
- **FR-010**: The change MUST NOT require the consumer (the MVP) to alter how it persists credentials or poll keysets; catch-up MUST work with the consumer's existing durable state.
- **FR-011**: The criterion the Gateway uses to decide whether an inbound item is dispatchable MUST be simplified to depend on authorized-group membership plus the at-most-once / own-send guards, rather than on the "live vs not-live" delivery tag. The previous "dispatch only live items" rule MUST be removed or reduced to the group filter, since its sole purpose (excluding echoes and history) is now served by the own-send claim and the dedup guard.
- **FR-013**: This feature is scoped to the **offline catch-up flush only** — the device-addressed traffic WhatsApp queues while the Gateway is offline and flushes on reconnect. Full older-history sync (the separate channel that pushes chat history predating the session) MUST remain disabled and unconsumed; the Gateway MUST NOT need to reprocess entire chat history to satisfy outage catch-up. (See "Out of Scope" and "Future Enhancements".)
- **FR-012**: The behaviour change MUST be covered by automated tests at the Gateway boundary (per the project's test-first standard), including: a recovered new vote, a recovered changed vote, a recovered authorized-group message, suppression of a recovered own-send echo, and rejection of a recovered unauthorized-chat item.

### Key Entities *(include if feature involves data)*

- **Inbound catch-up item**: a message or poll-vote update that WhatsApp re-delivers on reconnect because it arrived while the Gateway was offline. Distinguished today only by its "not-live" delivery tag; this feature reclassifies it as genuine inbound activity subject to the same guards as live traffic.
- **Own-send claim**: a record that the Gateway itself originated a given `(chat, message-id)`, established at send time, used to suppress that message's later echo. Conceptually the same identity the at-most-once guard already uses.
- **Recovered poll vote**: a poll-vote update recovered from catch-up, carrying the voter's full current selection, decrypted via the existing keyset and applied last-write-per-voter to the tally.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After an outage during which votes were cast or changed in the authorized group, a reconnected Gateway produces a poll tally **identical** to one that never went offline — zero missed or stale votes attributable to the outage.
- **SC-002**: After an outage during which messages were posted in the authorized group, **100%** of those messages are dispatched to the consumer on reconnect, each **exactly once**.
- **SC-003**: Across reconnect catch-up, **zero** echoes of the Gateway's own programmatic sends are reported to the consumer as new inbound activity.
- **SC-004**: Across reconnect catch-up, **zero** items from chats other than the authorized group are dispatched to the consumer (cross-chat leakage remains nil).
- **SC-005**: A reconnect following a large backlog completes catch-up without crashing and without any item being dispatched more than once.
- **SC-006**: The operator needs to take **no manual action** (no re-voting, no restart, no resync command) for outage traffic to be recovered.

## Assumptions

- **Outage catch-up arrives on the standard inbound channel.** The missed traffic WhatsApp re-delivers on reconnect arrives through the same inbound message delivery the Gateway already listens on, merely tagged "not live". Handling that tag is sufficient for catch-up; this is the mechanism the feature targets. (Investigated and confirmed against the installed library behaviour, 2026-06-16.)
- **Bulk older-history sync is a separate, orthogonal mechanism and is out of scope.** Pulling the *full prior chat history* (older than the outage) is a different delivery channel the Gateway does not consume; it is **not required** for outage catch-up and is explicitly excluded (see Out of Scope). This feature relies solely on the offline catch-up flush.
- **The server defines how far back catch-up reaches.** How much missed traffic is recoverable is governed by what WhatsApp's server retained for this device while offline, not by the Gateway. The Gateway processes whatever the server flushes on reconnect; it imposes no additional age bound of its own. A backlog the server has already discarded is unrecoverable by any means and is out of scope.
- **The at-most-once guard's window is sufficient for a reconnect burst.** The existing dedup guard covers a recent window large enough to absorb burst-style re-deliveries (per FR-034); catch-up bursts fall within this design intent. Tuning the window size, if needed, is an implementation concern.
- **The durable poll keyset survives the outage.** The consumer's persisted poll keyset (the restart-proof decryption fallback) remains available across the outage, so recovered votes for an existing poll can be decrypted. Votes for a poll with no recoverable keyset are skipped without error, as today.
- **Single authorized group, single operator.** Consistent with the current MVP scope; catch-up is reasoned about for the one authorized group.
- **Claiming own sends fully replaces the notify-only filter's protective role.** The investigation indicates that marking the Gateway's own outbound sends as accounted-for at send time, combined with the existing dedup guard, removes the echo-double-dispatch risk that originally justified dropping the "not-live" stream. This is to be confirmed during planning/implementation (Open Question 3) and is the premise of FR-004/FR-011.

## Out of Scope

- **Full older-history sync.** Enabling `syncFullHistory` / consuming the separate history-sync channel that pushes chat history predating the session is explicitly out of scope (decision: 2026-06-16). The offline catch-up flush already recovers the outage window and cannot over-reach (the server only flushes what it queued for this device while offline), so no "last-synced-message" bookkeeping is needed. History sync is heavier (new event handling + an age bound + per-team storage) and it is undocumented whether it even carries incremental poll-*vote* updates — so it would not reliably serve the primary goal. Captured as a future enhancement below.

## Future Enhancements

- **History-sync-based recovery (Option B).** A belt-and-braces layer for the case where the server's offline buffer was discarded (very long outage) or after a fresh re-pair: enable full-history sync, add a `teams.last_synced_message` (or equivalent) marker so recovery does not go back too far, consume the history-sync channel, and reconcile recovered messages. Deferred because (a) the offline catch-up flush covers the reported scenario, and (b) history sync's coverage of poll-vote updates is unverified.

## Open Questions *(to resolve in clarify/plan)*

1. **Any Gateway-imposed bound on catch-up age?** Default assumption is "process whatever the server flushes, no extra bound." Confirm no business need to ignore very old recovered items (e.g. votes on a poll the operator considers closed).
2. **Confirm the own-send claim fully neutralises echoes.** Validate (in planning/implementation) that claiming each outbound `(chat, message-id)` at send time suppresses every echo form the protocol can return (including any alternate address form of the same message), so relaxing the live-only filter introduces no regression in echo suppression.

## Dependencies

- **Feature 002 (WhatsApp Gateway)**: this feature alters the Gateway's inbound dispatch behaviour. It builds on the existing connection/reconnection lifecycle, authorized-group filter, poll-vote decryption, and identity canonicalization.
- **Feature 003 Phase 9 (FR-034 at-most-once dispatch)**: the in-memory claim/dedup guard is the mechanism this feature relies on to make relaxing the live-only filter safe.
