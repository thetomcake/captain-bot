# Contract: Poll-Posting Pin / Unpin Integration (MVP)

**Feature**: 007-auto-pin-poll | Surface: `PollService.postOrReplaceNextPoll` +
`PollService.removeExistingPoll`. Implements spec FR-002, FR-003, FR-004, FR-005, FR-006, FR-008.

## Clock seam (FR-008)

`PollService` constructor gains `now: () => Date = () => new Date()` (last param, after
`keysetStore`), mirroring `FixtureService`. The pin window is
`secondsUntilGame = Math.floor((game.gameDate.getTime() - now().getTime()) / 1000)`.

## Behaviour

| # | Given | When | Then |
|---|-------|------|------|
| P1 | no existing poll; next fixture's `gameDate` is `now + 3 days` | `postOrReplaceNextPoll()` | after `sendPoll` + keyset persist, calls `gateway.pinMessage(newRef, ~259200)`; outcome `posted`. (`selectPinDuration(259200) ⇒ 604800` inside the gateway.) |
| P2 | no existing poll; pin send fails (`pinMessage` returns `{ ok: false }`) | `postOrReplaceNextPoll()` | poll is still `posted`, keyset persisted, `lastPollPostedAt` stamped; the failure is logged; **no throw** (FR-006). |
| P3 | an existing pinned poll for the fixture; `force: true` | `postOrReplaceNextPoll()` | order is: send new poll → in `removeExistingPoll`: delete DB rows → **`unpinMessage(oldRef)` then `deleteMessage(oldRef)`** → persist new keyset → `pinMessage(newRef, …)`; outcome `replaced`. |
| P4 | replacement; old poll's `deleteMessage` returns `{ ok: false }` | `postOrReplaceNextPoll()` | replacement still completes; old poll was **unpinned before** the failed delete (FR-005); new poll pinned; failures logged. |
| P5 | replacement; `unpinMessage(oldRef)` returns `{ ok: false }` | `postOrReplaceNextPoll()` | replacement still proceeds to delete + new-poll pin; the unpin failure is logged only (FR-006). |
| P6 | existing poll present and `force` not set | `postOrReplaceNextPoll()` | returns `exists`; **no** send, no pin, no unpin (unchanged behaviour). |
| P7 | a fixed injected `now` and a known `gameDate` | `postOrReplaceNextPoll()` | the `durationSeconds` passed to `pinMessage` equals `floor((gameDate - now)/1000)` exactly (deterministic, FR-008). |
| P8 | `previewNextPoll()` (`--dry-run`) | called | no send, no pin/unpin (unchanged). |

## Invariants

- Pinning/unpinning happen **only through `IWhatsAppGateway`** — `PollService` imports no Baileys
  (FR-007). Unchanged: it already depends only on the port.
- Pin/unpin are the **last best-effort side-effects** of a successful post/replace; neither their
  failure nor an unexpected throw (defensively caught) changes the `PostPollOutcome` or the DB state
  (FR-006).
- Game time is always in the future (next-fixture selection guarantee) ⇒ `secondsUntilGame > 0` ⇒ a
  pin is always attempted on a successful post.
