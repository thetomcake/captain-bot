# Contract: Gateway `pinMessage` / `unpinMessage`

**Feature**: 007-auto-pin-poll | Surface: `IWhatsAppGateway` (port) + `WhatsAppGateway` (concrete) +
`FakeGateway` (test double). Implements spec FR-001, FR-002, FR-006, FR-007.

## Signatures

```ts
pinMessage(ref: MessageRef, durationSeconds: number): Promise<PinOutcome>; // never throws
unpinMessage(ref: MessageRef): Promise<PinOutcome>;                        // never throws

type PinOutcome = { ok: true } | { ok: false; reason: 'network' | 'unknown'; detail?: string };
```

## `pinMessage(ref, durationSeconds)`

| # | Given | When | Then |
|---|-------|------|------|
| C1 | connected; `ref` is a previously-sent message; `durationSeconds = 90_000` (~25h) | called | issues `sendMessage(ref.groupId, { pin: key, type: PIN_FOR_ALL, time: 604800 })` — bucket selected by `selectPinDuration` (90 000 > 86 400 ⇒ 7d) — and returns `{ ok: true }`. |
| C2 | connected; `durationSeconds = 3_600` (1h) | called | uses `time: 86400` (smallest bucket ≥ window) and returns `{ ok: true }`. |
| C3 | connected; `durationSeconds = 5_000_000` (> 30d) | called | uses `time: 2592000` (30d cap) and returns `{ ok: true }`. |
| C4 | connected; the underlying send throws a transport error | called | returns `{ ok: false, reason: 'network', detail? }`; **does not throw**; logs at warn (no secrets). |
| C5 | connected; the underlying send throws a non-transport error | called | returns `{ ok: false, reason: 'unknown', detail? }`; **does not throw**. |
| C6 | NOT connected | called | rejects via the existing `connectedSocket()` guard (same precondition as `sendMessage`/`deleteMessage`). *(This is the one throwing path — a programmer/precondition error, identical to the other sends; the MVP only ever calls it post-`sendPoll`, i.e. while connected.)* |
| C7 | the message key is still cached in the in-session `MessageStore` | called | pins using the genuine cached `key`; otherwise reconstructs `{ remoteJid: ref.groupId, fromMe: true, id: ref.id }` (same strategy as `deleteMessage`). |
| C8 | any pin send | called | routed through the existing `sendLimiter` (≤5 msg/min) so ban-risk profile is unchanged. |

## `unpinMessage(ref)`

| # | Given | When | Then |
|---|-------|------|------|
| C9 | connected; `ref` previously sent | called | issues `sendMessage(ref.groupId, { pin: key, type: UNPIN_FOR_ALL })` (no `time`) and returns `{ ok: true }`. |
| C10 | connected; send throws | called | returns `{ ok: false, reason }`; **does not throw**; logs at warn. |
| C11 | key cached / not cached | called | same cached-key-or-reconstruct strategy as C7. |

## Invariants

- **Fire-and-forget**: `{ ok: true }` means the (un)pin stanza was *sent*, not that WhatsApp confirmed
  it (no server ack — verified vs `7.0.0-rc13`, consistent with `deleteMessage`).
- **No Baileys type leaks**: `pinMessage`/`unpinMessage` accept/return only public domain types
  (`MessageRef`, `PinOutcome`, `number`); `proto.PinInChat.Type` and the discrete `time` literals stay
  inside `gateway.ts` + `messages/pin-duration.ts`.
- **Bucketing is internal**: callers pass real seconds-until-event; the gateway chooses the WhatsApp
  bucket. Callers never see `86400 | 604800 | 2592000`.

## Pure helper `selectPinDuration(requestedSeconds): 86400 | 604800 | 2592000`

| Input (seconds) | Output |
|-----------------|--------|
| `≤ 0` (defensive; unreachable in MVP) | `86400` |
| `1 … 86400` | `86400` |
| `86401 … 604800` | `604800` |
| `604801 … 2592000` | `2592000` |
| `> 2592000` | `2592000` |
