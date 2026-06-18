# Feature Specification: Auto-Pin the Availability Poll Until Game Time

**Feature Branch**: `007-auto-pin-poll`

**Created**: 2026-06-18

**Status**: Draft

**Input**: User description: "I want to add automatic message pinning to the send poll, this will touch both the MVP (003 and 006) and the whatsapp gateway (002) - we should do this in a separate new feature. Research must use baileys official documentation via the website and only use source code if it is required for clarity. Only reference documentation for the pinner version. This should be a very small task and restricted to as few steps as possible. We should pin the poll until the game time by calculating difference between now and game time."

## Overview

When the system posts an availability poll for the next fixture, that poll can be quickly buried by ordinary chat in a busy group, so players miss it. This feature makes the system **automatically pin the availability poll** in the group the moment it is posted, and keep it pinned for the time remaining **until the fixture's game time** (the poll's relevance window). Once game time arrives the pin is no longer needed and falls away. The result: from the moment a poll goes up until the match itself, the poll sits at the top of the group where players can find and answer it.

This is a small, additive capability. It introduces new "pin a message" and "unpin a message" operations on the WhatsApp Gateway (the existing seam the MVP already uses to send messages and polls) and wires the existing poll-posting flow to pin a poll after it is successfully posted — and to unpin a superseded poll before deleting it when a poll is replaced. Both operations are best-effort and never block poll posting.

## Glossary

- **Availability poll**: the single-choice poll the system posts for the next confirmed fixture asking who is available.
- **Game time**: the fixture's scheduled kick-off date/time, already stored against the fixture.
- **Pin window**: the span from when the poll is posted until game time — how long the poll should stay pinned.
- **Pin / Unpin**: making a message stick to the top of the group (with a duration) / removing that pin.
- **Gateway**: the standalone WhatsApp integration library (feature 002) the MVP consumes for all WhatsApp actions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Poll is pinned for its relevant window when posted (Priority: P1)

When the system posts an availability poll for the next fixture, the poll is automatically pinned in the group so it stays visible at the top until the game is played.

**Why this priority**: This is the entire user-facing value of the feature — without it the poll can scroll out of view and responses drop.

**Independent Test**: Post a poll for a fixture whose game time is in the future. Confirm the poll appears pinned in the group, and that its pin is set to last for (approximately) the time between posting and game time.

**Acceptance Scenarios**:

1. **Given** a confirmed next fixture with a game time in the future, **When** the system posts the availability poll, **Then** that poll message is pinned in the same group.
2. **Given** the poll has just been posted, **When** the pin is applied, **Then** the pin's duration corresponds to the time remaining from now until the fixture's game time.
3. **Given** an existing poll for the fixture is force-replaced with a new one, **When** the replacement poll is posted, **Then** the new poll message is the one that ends up pinned.

---

### User Story 2 - Replacing a poll unpins the old one before removing it (Priority: P2)

When an existing poll for the fixture is force-replaced, the system unpins the superseded poll before deleting it, then pins the new poll. Attempting the unpin first means that even if the underlying delete fails, the old poll is no longer stuck at the top of the group competing with the new one.

**Why this priority**: Without unpinning first, a delete failure during replacement would leave a stale poll pinned alongside the fresh one, confusing players about which poll to answer.

**Independent Test**: Force-replace an existing pinned poll and confirm the old poll is unpinned before the delete is attempted, and the new poll ends up pinned — including the case where the old poll's delete fails (the old poll is still unpinned).

**Acceptance Scenarios**:

1. **Given** an existing pinned poll for the fixture, **When** the poll is force-replaced, **Then** the old poll is unpinned before its deletion is attempted and the new poll is pinned.
2. **Given** the old poll's deletion fails during replacement, **When** replacement completes, **Then** the old poll has still been unpinned and the failure is logged without aborting the flow.

---

### User Story 3 - Pinning and unpinning never block or break poll posting (Priority: P2)

Any failure to pin or unpin (e.g. the group does not permit pinning, or the platform rejects the request) must not prevent the poll from being posted, replaced, or recorded.

**Why this priority**: Posting the poll is the critical action; pin/unpin are enhancements. A pinning problem must never cost the team its poll.

**Independent Test**: Force the pin and unpin operations to fail and confirm the poll is still posted, recorded, and its votes still tracked, with the failures surfaced in logs rather than aborting the flow.

**Acceptance Scenarios**:

1. **Given** the poll has been posted successfully, **When** the pin operation fails, **Then** the poll remains posted and recorded and the failure is logged without raising an error to the caller.
2. **Given** a poll is being replaced, **When** the unpin operation for the old poll fails, **Then** replacement still proceeds and the failure is logged.

---

### Edge Cases

- **Pin / unpin not permitted or rejected by the platform**: treated as a non-fatal failure (logged, swallowed) exactly like a failed message delete in the existing replace flow.
- **Poll replacement with a failing delete**: the old poll is unpinned first, so even when its delete fails it no longer stays pinned; only the newly posted poll ends up pinned.
- **Platform-imposed maximum pin duration**: if the time until game time exceeds the longest pin duration the platform supports, the poll is pinned for the longest supported duration that still keeps it pinned through the window (see Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Gateway MUST expose an operation to pin an already-sent message in a group for a caller-specified duration.
- **FR-002**: The Gateway MUST expose an operation to unpin an already-sent message in a group.
- **FR-003**: The system MUST pin the availability poll in the group immediately after the poll is successfully posted.
- **FR-004**: The system MUST set the pin duration to the time remaining between the moment of posting ("now") and the fixture's game time.
- **FR-005**: When a poll is force-replaced, the system MUST attempt to unpin the superseded poll **before** deleting it, then pin the newly posted poll (not the superseded one).
- **FR-006**: Pinning and unpinning MUST both be best-effort: a failure of either MUST NOT abort poll posting, replacement, recording, or vote tracking; it MUST be logged and otherwise ignored (consistent with the existing best-effort delete behaviour).
- **FR-007**: The MVP MUST request pinning and unpinning only through the existing Gateway seam (`IWhatsAppGateway`) and MUST NOT call the underlying protocol library directly.
- **FR-008**: The "now" used to compute the pin window MUST be supplied through the same injectable clock the rest of the feature set uses, so the duration calculation is deterministically testable.

### Key Entities *(include if feature involves data)*

- **Pin request**: a reference to an already-sent message (its group and message identifier) plus the duration the pin should last. Derived, not persisted — no new stored data is introduced by this feature.
- **Unpin request**: a reference to an already-sent message (its group and message identifier) to remove from the pinned position. Derived, not persisted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of availability polls posted are pinned in the group at post time.
- **SC-002**: The applied pin duration equals the interval between posting time and game time (within the granularity the platform supports), verified for representative windows.
- **SC-003**: When pinning or unpinning fails for any reason, 100% of polls are still posted/replaced and their votes still tracked — zero polls are lost to a pin/unpin failure.
- **SC-004**: On replacement, the superseded poll is unpinned before its deletion is attempted in 100% of cases, including when that deletion fails.

## Assumptions

- **Game time is always in the future at post time**: next-fixture selection (features 003/006) only ever resolves an unplayed, future-dated fixture, so the pin window is always positive — a zero or negative "now → game time" interval cannot occur and is not handled.
- **Pinning targets the same group as the poll**: polls are posted to a single authorized group, and the pin/unpin are applied in that same group.
- **Best-effort semantics**: pinning and unpinning follow the project's existing best-effort pattern for non-critical WhatsApp side-effects (like deleting a replaced poll) — they never throw to the poll-posting caller.
- **Platform duration granularity**: the underlying platform may only support pinning for a bounded or discrete set of durations. Where the exact "now → game time" interval cannot be requested verbatim, the system selects the smallest supported duration that still keeps the poll pinned through to game time, and if the interval exceeds the platform's maximum it uses that maximum. The precise supported durations are an implementation detail to be confirmed against the pinner-version documentation during planning.
- **No new persisted state**: the pin is a transient WhatsApp side-effect; the feature stores nothing new and adds no schema change.
- **Scope**: this feature covers pinning the availability poll and unpinning a superseded poll during replacement only. It does not add user-facing manual pin/unpin commands, does not pin other message types, and does not re-pin or refresh the pin after the initial post.

## Dependencies

- **Feature 002 (WhatsApp Gateway)**: gains new pin and unpin operations on its public surface and on the `IWhatsAppGateway` port the MVP consumes.
- **Features 003 / 006 (MVP poll posting & next-fixture selection)**: the poll-posting flow pins the poll after a successful send (using the resolved fixture's game time) and unpins the superseded poll before deleting it on replacement.
