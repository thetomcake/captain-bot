# Phase 0 Research: Auto-Pin the Availability Poll

**Feature**: 007-auto-pin-poll | **Date**: 2026-06-18

Research priority (per the feature request): **official Baileys website documentation first; fall
back to the installed source only where the website is silent or unclear.** Only the installed
**pinner version** — `@whiskeysockets/baileys@7.0.0-rc13` — is referenced.

## §1 — Does the installed Baileys version support pinning, and with what API?

**Decision**: Pin/unpin a message via the `sendMessage` content option `{ pin, type, time }`:

```ts
// Pin (PIN_FOR_ALL = 1), with a discrete duration:
await sock.sendMessage(jid, { pin: messageKey, type: proto.PinInChat.Type.PIN_FOR_ALL, time: 604800 });

// Unpin (UNPIN_FOR_ALL = 2), no time:
await sock.sendMessage(jid, { pin: messageKey, type: proto.PinInChat.Type.UNPIN_FOR_ALL });
```

- `pin` is a **`WAMessageKey`** — the key of the already-sent message to (un)pin.
- `type` is **`proto.PinInChat.Type`**: `UNKNOWN_TYPE = 0`, `PIN_FOR_ALL = 1`, `UNPIN_FOR_ALL = 2`.
- `time` (pin only) is the duration in seconds.

**Rationale / sources**:
- **Website** ([baileys.wiki](https://baileys.wiki/docs/socket/sending-messages)): the official docs'
  "Sending Messages" section enumerates text/media/forwarding/deleting/editing/reaction but **has no
  pinning page** — the website is silent on pinning. A general web reference corroborated the
  `type`/`time` concept (type `1` to pin, `0`/`2` to remove; `time` in seconds; 24h/7d/30d examples)
  — see [npm @whiskeysockets/baileys](https://www.npmjs.com/package/@whiskeysockets/baileys).
- **Source fallback** (authoritative for our version), `node_modules/@whiskeysockets/baileys@7.0.0-rc13`:
  - `lib/Types/Message.d.ts` — the `AnyRegularMessageContent` union member:
    ```ts
    { pin: WAMessageKey; type: proto.PinInChat.Type; /** 24 hours, 7 days, 30 days */ time?: 86400 | 604800 | 2592000 }
    ```
  - `lib/Utils/messages.js` — the generator branch:
    ```js
    else if (hasNonNullishProperty(message, 'pin')) {
      m.pinInChatMessage = { key: message.pin, type: message.type, senderTimestampMs: Date.now() };
      m.messageContextInfo = { messageAddOnDurationInSecs: message.type === 1 ? message.time || 86400 : 0 };
    }
    ```
  - `WAProto/index.d.ts` — `proto.PinInChat.Type { UNKNOWN_TYPE = 0, PIN_FOR_ALL = 1, UNPIN_FOR_ALL = 2 }`.

**Alternatives considered**: a dedicated `sock.chatModify`/`pin` helper — not present for message
pinning in rc13; the `sendMessage({ pin })` content path is the supported mechanism.

## §2 — What durations does WhatsApp actually allow? (the key constraint)

**Decision**: Pin duration is a **discrete set — 86400 (24h), 604800 (7d), 2592000 (30d)** — not an
arbitrary number of seconds. "Pin until game time" is implemented as: compute `gameDate − now` in
seconds, then **pick the smallest of these three buckets that is ≥ the window**; if the window
exceeds 30d, use 2592000 (the max). This realises the spec's documented "platform duration
granularity" assumption (FR-004).

**Rationale**: The installed TypeScript type literally constrains `time` to `86400 | 604800 | 2592000`,
and the generator defaults a pin with no/zero `time` to `86400`. Passing an arbitrary value would not
type-check and would not reflect a real WhatsApp pin window. For this app the realistic window is a
day-to-a-week-or-two out, so the mapping is almost always 24h or 7d.

Bucket mapping (pure function `selectPinDuration(secondsUntilGame)`):

| Seconds remaining until game time | Selected `time` |
|-----------------------------------|-----------------|
| `> 0` and `≤ 86400` (≤ 24h)       | `86400`         |
| `> 86400` and `≤ 604800` (≤ 7d)   | `604800`        |
| `> 604800` and `≤ 2592000` (≤ 30d)| `2592000`       |
| `> 2592000` (> 30d)               | `2592000` (cap) |

The non-positive case (`≤ 0`) cannot occur — next-fixture selection only ever returns a future-dated
fixture (spec assumption); the helper still treats `≤ 0` defensively by returning the minimum bucket,
but the MVP never reaches it.

**Alternatives considered**: leaking the discrete set into the MVP (rejected — it's a Baileys/platform
detail that belongs below the gateway seam, FR-007); re-pinning/refreshing as game time nears
(rejected — out of scope per spec; the chosen bucket already covers the window).

## §3 — Where does duration bucketing belong: Gateway or MVP?

**Decision**: **Below the Gateway seam.** `pinMessage(ref, durationSeconds: number)` accepts a plain
"seconds until kick-off" and internally calls `selectPinDuration()` to choose the Baileys bucket. The
MVP passes `secondsUntilGame` and never sees the discrete set.

**Rationale**: Feature 002's whole premise is "absorb Baileys complexity behind a small stable
interface; the MVP never touches the protocol library" (FR-007). The discrete-duration rule is
exactly such a protocol detail. Keeping it in the gateway also keeps the MVP requirement (FR-004:
"duration = now → game time") expressed in domain terms.

**Alternatives considered**: MVP computes the bucket (rejected — leaks Baileys constraint upward).

## §4 — Error handling: best-effort, never throws (FR-005/FR-006)

**Decision**: `pinMessage`/`unpinMessage` return a `PinOutcome` and **never throw**, mirroring the
existing `deleteMessage` → `DeleteOutcome` contract:

```ts
type PinOutcome = { ok: true } | { ok: false; reason: 'network' | 'unknown'; detail?: string };
```

**Rationale**: A pin is a `sendMessage` send, so it shares the revoke/delete fire-and-forget profile
(verified for delete in `gateway.ts`/`messages/delete-classifier.ts`, rc13): no server ack, so the
only synchronously-observable failures are a transport drop mid-send (`network`) or an
encryption/precondition fault (`unknown`). WhatsApp-side rejections (e.g. not permitted) are not
surfaced as thrown errors and so cannot be reported synchronously — consistent with why
`DeleteOutcome`'s `window-expired`/`not-found` are reserved-but-unproduced. The MVP logs a non-`ok`
outcome and proceeds (FR-006). The gateway reuses the `deleteMessage` key strategy: prefer the cached
message `key` from the in-session `MessageStore`, else reconstruct `{ remoteJid, fromMe: true, id }`.
Pin/unpin sends are routed through the existing `sendLimiter` (≤5 msg/min) to keep the ban-risk
profile unchanged (FR-016 of 002).

**Alternatives considered**: throwing on failure (rejected — violates best-effort FR-006 and breaks
parity with `deleteMessage`).

## §5 — Injectable clock for the duration window (FR-008)

**Decision**: Add `now: () => Date = () => new Date()` to `PollService`'s constructor (the same seam
`FixtureService` already uses) and compute `secondsUntilGame = Math.floor((game.gameDate.getTime() −
this.now().getTime()) / 1000)`.

**Rationale**: `FixtureService` already threads an injectable `now` for the year-boundary and
future-date guards (006); reusing the identical pattern keeps the duration calculation deterministically
testable against a fixed clock without a real-time dependence, and stays consistent across the feature
set.

**Alternatives considered**: a shared global clock module (rejected — heavier than the established
per-service `now` seam; nothing else needs it).

## §6 — Ordering on replacement: unpin before delete (FR-005)

**Decision**: In `PollService.removeExistingPoll`, call `unpinMessage(oldRef)` **before**
`deleteMessage(oldRef)`. Then the new poll is pinned after it is sent + persisted.

**Rationale**: The gateway's revoke is fire-and-forget and a delete can fail (`{ ok: false }`).
Unpinning first guarantees that even when the old poll's delete fails it is no longer stuck at the top
competing with the fresh poll (spec US2). Both calls are best-effort and logged.

**Alternatives considered**: delete-then-unpin (rejected — if delete "succeeds" fire-and-forget but
the message lingers and unpin is skipped, a stale pin can remain); relying on delete to implicitly
unpin (not guaranteed by the protocol).
