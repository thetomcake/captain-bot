# Quickstart: Validating Offline Catch-Up on Reconnect

**Feature**: `004-offline-catch-up` | **Date**: 2026-06-16

This guide validates the feature end-to-end. The **automated** portion (the dispatch-eligibility
decision and own-send claim) runs in CI; the **manual** portion exercises the real reconnect path
against a live WhatsApp session, which cannot run in CI (ratified spec-002 exclusion).

References: dispatch rule → [contracts/dispatch-eligibility.md](./contracts/dispatch-eligibility.md);
entities → [data-model.md](./data-model.md); rationale → [research.md](./research.md).

---

## Prerequisites

- A paired Gateway session (run `bin/connect.ts` once and scan the QR if not already paired).
- `AUTHORIZED_GROUP_ID` set to a test WhatsApp group you control.
- A **second** WhatsApp account (or a second member) in that group to post messages / cast votes
  while the Gateway is offline.
- A way to take the daemon offline that mimics an internet outage (kill the process, or drop the
  host's network) — not a clean logout, which would re-pair rather than catch up.

---

## A. Automated checks (CI)

```bash
npm test -- tests/unit/whatsapp-gateway/message-mapper.test.ts \
            tests/unit/whatsapp-gateway/message-store.test.ts
```

**Expected**: the FR-012 scenarios in [contracts](./contracts/dispatch-eligibility.md#test-obligations)
pass — recovered `append` message dispatches, recovered own-send echo is suppressed, recovered
unauthorized-chat item is dropped, recovered new/changed votes route and apply last-write-wins, and
an own-send-claimed key fails a second `claimOnce` while a manual-send id does not.

Full suite (must stay green and within the project's time budget):

```bash
npm test
```

---

## B. Manual: recovered poll votes (US1 / SC-001) — the reported defect

1. Start the listener + vote watcher against the authorized group:
   ```bash
   tsx src/whatsapp-gateway/bin/watch-votes.ts
   ```
2. Post a poll (CLI poll path or `bin/send-poll.ts`) and cast one vote from the second account.
   Confirm the tally updates live.
3. **Take the Gateway offline** (kill the process / drop the network).
4. While offline, from the second account: cast a **new** vote and **change** an existing vote
   (and optionally **clear** a selection).
5. **Bring the Gateway back online** (restart / restore network) and let it reconnect.

**Expected**:
- The new vote, the changed vote, and the withdrawal are all decrypted and applied on reconnect —
  the tally matches what it would be had the Gateway never gone offline (SC-001).
- Each recovered vote is applied **once** (no double-count); `MessageCounterError` lines appear at
  debug level only, not as errors (FR-009).
- No re-vote, restart command, or resync was needed (SC-006).

---

## C. Manual: recovered group messages (US2 / SC-002)

1. Start the listener:
   ```bash
   tsx src/whatsapp-gateway/bin/listen.ts
   ```
2. Take the Gateway offline.
3. From the second account, post several messages in the authorized group (include the kind the
   MVP reacts to, e.g. a stat-capture message and a `!`-command).
4. Bring the Gateway back online.

**Expected**: every message posted during the outage is dispatched to `onMessage` exactly once on
reconnect, with correct sender, text, and timestamp (SC-002). A large backlog completes without
the daemon crashing and without any duplicate (SC-005).

---

## D. Manual: own-send echo suppression (US3 / SC-003)

1. With the listener running (Section C), send a message and post a poll **via the Gateway**
   (`bin/send-message.ts`, `bin/send-poll.ts`).
2. Observe that neither the message echo nor the poll-creation echo is reported by `onMessage` as
   new inbound activity — live.
3. Repeat across a reconnect: send via the Gateway, take it offline, bring it back. Confirm the
   echoes are still suppressed on the catch-up flush (SC-003).
4. **Control**: from the operator's own linked account, send a message **manually** in the group.
   Confirm it **is** reported as inbound activity (FR-006) — proving suppression keys on the
   Gateway's own send id, not on `fromMe`.

---

## E. Manual: cross-chat isolation across catch-up (SC-004)

1. Take the Gateway offline.
2. From an account, send messages to a **different** chat (a DM or an unauthorized group) the
   linked account is in.
3. Bring the Gateway back online.

**Expected**: none of those non-authorized items are dispatched to the consumer on reconnect —
cross-chat leakage stays nil (SC-004), because the authorization chokepoint is unchanged.

---

## F. Manual: clean reconnect is unaffected (Edge Case)

1. With no outage, trigger a normal reconnect (e.g. the post-pairing handshake or a brief
   connection blip with no messages sent meanwhile).

**Expected**: behaviour is unchanged — no inappropriate history replay, no spurious dispatches.
Bulk older history is never pulled (`syncFullHistory: false`, no history-sync handler — FR-013).

---

## Done when

- Section A passes in CI.
- Sections B–F observed as described against a live test session.
- No item is dispatched more than once; no benign replay warning is surfaced as an error.
