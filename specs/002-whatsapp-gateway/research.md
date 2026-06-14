# Research: Standalone WhatsApp Gateway Library

## Scope & method

This document is the authoritative, **pinned-version** reference for wrapping Baileys in the Gateway. It was produced by reading the **actually-installed `@whiskeysockets/baileys@7.0.0-rc13`** type definitions and compiled source under `node_modules/@whiskeysockets/baileys/`, cross-checked against the official docs (https://baileys.wiki) and GitHub issues. **Where the installed source and general docs disagree, the installed source governs** (FR-031). A prior implementation got poll handling badly wrong by trusting docs/memory over the installed build — see [[baileys-pinned-version-fidelity]] discipline.

> ⚠️ **Re-verify on any version bump.** v7 is a Release Candidate mid-refactor. Pin the exact version (no `^`). Before changing the Baileys version, re-read the source paths cited here.

---

## Decision 0 — Engine & architecture

**Decision**: Wrap the existing `@whiskeysockets/baileys` (pinned `7.0.0-rc13`) in an in-house Gateway library. Confine Baileys-touching code to a thin orchestration shell + two helpers (auth store, vote decryptor); put all hard logic in pure, unit-tested units.

**Rationale**: Prior research (recorded in [[whatsapp-gateway-spec]]) eliminated every alternative — official Cloud API (no native polls, no group monitoring), whatsappi (abandoned), Evolution API (heavy sidecar, poll votes unreliable), WPPConnect / whatsapp-web.js / venom / open-wa (Chromium-heavy and/or fragile/paywalled group poll-vote support). Every viable path is the unofficial WhatsApp Web protocol, so a thin in-house wrapper gives the most control with the least added surface, and keeps the project's minimal-dependency philosophy.

**Alternatives considered**: See [[whatsapp-gateway-spec]] and the prior research summary; all rejected.

---

## Critical findings that shape the design

1. **Poll-vote auto-decryption is DISABLED in rc13 — by design.** In `lib/Utils/process-message.js` the `else if (content?.pollUpdateMessage) { … }` branch that decrypts votes and emits `messages.update` with `pollUpdates` is **commented out** (~lines 576–624, tagged `// TODO: make standalone, remove getMessage reference` / `// TODO: Remove entirely`). This was an intentional change (**commit `b7a9f7b`, 2025-03-14** — see §7 "Why in-core auto-decryption was disabled"), not a bug. **Consequence**: in rc13, votes do **not** arrive as decrypted `pollUpdates`. Raw `pollUpdateMessage` payloads still arrive via `messages.upsert`; the Gateway must decrypt them itself using the exported `decryptPollVote` + `getAggregateVotesInPollMessage`. Do not build on auto-emitted `pollUpdates`.
2. **`isJidUser` was renamed to `isPnUser`** in v7. Importing `isJidUser` fails.
3. **Baileys is ESM-only** (`"type": "module"`). Fine — the project is NodeNext ESM.
4. **`DisconnectReason.timedOut` and `connectionLost` are BOTH `408`** — they cannot be distinguished by status code; treat both as recoverable.
5. **v7 requires Node 20+** (the intro page's "17+" is stale). Project uses 22.
6. **New v7 auth key types** a custom store MUST handle: `lid-mapping`, `device-list`, `tctoken` (in addition to the v6 set). Missing these silently breaks LID/device handling.
7. **`WAMessageKey` gained `participantAlt` / `remoteJidAlt`** (the PN/LID counterpart) and `GroupMetadata` gained `addressingMode: 'pn' | 'lid'` — these are how you correlate the two identity forms.

---

## 1. Authentication & forced re-authentication — storage-agnostic

**Decision**: The library **never touches the filesystem or any database**. It holds auth state in memory only and is fully storage-agnostic (FR-008):
- The consumer optionally passes an **opaque, serialized credential snapshot** (`WhatsAppCredentials`) into the constructor. If omitted, the library starts fresh and QR-pairs.
- Whenever the session changes (initial pairing, `creds.update`, or any signal-key write), the library invokes a consumer-supplied `onCredentialsUpdate(snapshot)` callback (and exposes `getCredentials()` for on-demand retrieval). The consumer persists the snapshot wherever it likes (DB, file, secret manager) and passes it back next time via the constructor.
- The snapshot is **opaque** to the consumer: the library (de)serializes Baileys' `creds` + signal `keys` to/from it internally via `BufferJSON`. No Baileys type is exposed.

We deliberately do **not** use `useMultiFileAuthState` (it writes files) — it is only the reference for the in-memory store we build instead.

**APIs (verified, `lib/Types/Auth.d.ts`, `lib/Utils/auth-utils.d.ts`)**:
- `AuthenticationState = { creds: AuthenticationCreds; keys: SignalKeyStore }` — built **in memory** from the snapshot (or `initAuthCreds()` when none).
- `SignalKeyStore = { get(type, ids), set(data), clear?() }` implemented over an in-memory map. `SignalDataTypeMap` types that MUST round-trip through the snapshot: `pre-key`, `session`, `sender-key`, `sender-key-memory`, `app-state-sync-key`, `app-state-sync-version`, `identity-key`, **`lid-mapping`**, **`device-list`**, **`tctoken`**.
- `initAuthCreds()` — fresh creds when the constructor receives no snapshot.
- `BufferJSON.replacer` / `.reviver` — (de)serialize the `Buffer`/`Uint8Array` material into/out of the opaque snapshot.
- `makeCacheableSignalKeyStore(inMemoryStore, logger)` — caches the hot signal path over the in-memory keys.
- QR: render the `qr` string from `connection.update` yourself (no `printQRInTerminal`). Pairing-code alternative: `sock.requestPairingCode(e164WithoutPlus)` — requires a real `browser`.
- Wire `sock.ev.on('creds.update', …)` → re-serialize and fire `onCredentialsUpdate` (FR-012).

**Forced re-auth (FR-007)**: `try { await sock.logout() } catch {}` (may throw if already down) → clear the in-memory creds+keys (`keys.clear?.()`). The consumer then **discards its stored snapshot**; the next `connect()` QR-pairs fresh and emits a new snapshot via `onCredentialsUpdate`. (Logging out but reusing a stale snapshot causes a 401 resume loop.)

**Serialization note**: the snapshot includes the full signal keystore, which is written frequently, so `onCredentialsUpdate` may fire often. For this project's single-account, low-volume use that is fine; a consumer may debounce/throttle persistence. Snapshot round-trip (serialize → deserialize → equivalent `AuthenticationState`) is a **pure function**, unit-tested in `credentials.test.ts`.

**Docs**: https://baileys.wiki/docs/intro/ (types are authoritative).

---

## 2. Connection & reconnection

**Decision**: Reuse the MVP's proven approach (`src/whatsapp/client.ts`): a bounded **post-pairing 515 restart-handshake loop**, then classify every close into `recover | terminal | restart`, with an exponential backoff (jittered, capped) for recoverable closes.

**Verified (`lib/Types/State.d.ts`, `lib/Types/index.d.ts`)**:
- `connection.update` → `Partial<ConnectionState>`: `{ connection: 'open'|'connecting'|'close'; lastDisconnect?: { error; date }; qr?; isNewLogin?; receivedPendingNotifications?; isOnline? }`.
- Status code: `(lastDisconnect?.error as Boom)?.output?.statusCode`.
- `DisconnectReason` exact values: `connectionClosed=428`, `connectionLost=408`, `timedOut=408`, `connectionReplaced=440`, `loggedOut=401`, `badSession=500`, `restartRequired=515`, `multideviceMismatch=411`, `forbidden=403`, `unavailableService=503`.

**Classification (drives `disconnect-classifier.ts`)**:
- **restart** → `515` (expected immediately after first pairing): reconnect instantly with saved creds; bound attempts (MVP uses `MAX_RESTART_HANDSHAKES = 5`) so a stuck loop fails loudly.
- **recover** (backoff + reconnect) → `408` (lost/timedOut), `428` (closed), `503` (unavailable). `440` (replaced) = another device took over — reconnect cautiously or treat as terminal per config.
- **terminal** (stop, surface, may need wipe) → `401` (loggedOut), `403` (forbidden), `411` (multideviceMismatch), `500` (badSession).

**`getMessage` config requirement (`lib/Types/Socket.d.ts`)**: `getMessage: (key) => Promise<proto.IMessage | undefined>`. Baileys calls it to resend messages on poor connections and (historically) for poll decryption. Wire it to a **bounded in-memory cache of recently sent/received messages** so our outbound messages/polls are re-delivered when a recipient requests a retry-receipt. A miss returns `undefined` (best-effort; the cache is empty after a restart). The same cache is also the **first-choice source of a poll's `messageSecret`** when the poll-creation message is still present (§7); the consumer's keyset is the durable fallback.

**Docs**: https://baileys.wiki/docs/socket/connecting · canonical reconnect pattern in Baileys `Example/example.ts`.

---

## 3. Listing groups

**Verified (`lib/Socket/groups.d.ts`, `lib/Types/GroupMetadata.d.ts`)**:
- `sock.groupFetchAllParticipating()` → `Promise<{ [jid: string]: GroupMetadata }>`.
- `GroupMetadata`: `id`, `subject` (name), `participants`, `size`, `owner`/`ownerPn`, `desc`, `announce`, `restrict`, **`addressingMode?: 'pn' | 'lid'`** (decisive for vote handling), etc.
- Single group: `sock.groupMetadata(jid)`.

**Gotcha**: WhatsApp rate-limits metadata fetches and can flag spammy fetching — cache results; the Gateway only needs this for the one-time `list-groups` action and to read `addressingMode` for the authorized group.

---

## 4. Sending messages

**Verified (`lib/Socket/messages-send.d.ts`, `lib/Types/Message.d.ts`)**:
- `sock.sendMessage(jid, { text }, options?)` → `Promise<WAMessage | undefined>` (**handle `undefined`**).
- Returned `WAMessage.key` (`WAMessageKey`): `{ remoteJid, fromMe, id, participant?, remoteJidAlt?, participantAlt?, addressingMode? }`. `key.id` is the reference the Gateway returns (FR-013) and later uses for delete.
- Rate-limit via the Gateway's own `RateLimiter` (≤5/min, FR-016).

**Docs**: https://baileys.wiki/docs/socket/sending-messages

---

## 5. Receiving messages

**Verified (`lib/Types/Events.d.ts`)**:
- `messages.upsert` → `{ messages: WAMessage[]; type: 'notify' | 'append'; requestId? }`.
- **`'notify'`** = newly received → route to consumer. **`'append'`** = history/echo (your own sent poll comes back as `'append'`) → **do not report as new inbound** (FR-015). The MVP already learned this the hard way; the Gateway dispatches only `'notify'` items as new inbound activity. It keeps a **bounded in-memory cache** of sent/received messages for Baileys send-retries (`getMessage`) and as a poll-secret fast-path; poll-vote decryption falls back to the consumer's keyset when the poll-creation message isn't cached (§7).
- Text: `msg.message?.conversation ?? msg.message?.extendedTextMessage?.text`.
- Sender: `msg.key.participant` (group), `msg.key.participantAlt` (counterpart). Group: `msg.key.remoteJid`. `messageTimestamp` is seconds (may be `Long`; normalize).

**Docs**: https://baileys.wiki/docs/socket/handling-messages

---

## 6. Sending polls

**Verified (`lib/Types/Message.d.ts`)**:
- `sock.sendMessage(groupJid, { poll: { name, values, selectableCount, messageSecret?, toAnnouncementGroup? } })`.
- `selectableCount`: the Gateway always sends `1` (single-choice). **Multi-select is out of scope for now** and is not exposed on `PollSpec`. Validate **2–12 options** in `poll-options.ts` before sending (WhatsApp client caps at 12; Baileys does not enforce).
- Returned `WAMessage` contains `message.pollCreationMessage` and **`message.messageContextInfo.messageSecret`** (32 bytes) — the key needed to decrypt every future vote.
- **The Gateway captures the secret into the keyset (storage-agnostic):** after sending, read `messageContextInfo.messageSecret` from the returned message, base64-encode it, and return it — with `pollId`, `groupId`, and `options` — as the **`PollKeyset`** from `sendPoll` (FR-020/FR-021). The **consumer persists the keyset** and hands it back via `resolvePollKeyset` when a vote arrives (§7). The Gateway does **not** *persist* the poll-creation `WAMessage`, but a copy lives in the bounded in-memory store for the session, giving a fast path to the `messageSecret`+options; the consumer's keyset is the durable, restart-proof source (§7).

---

## 7. Handling poll votes (most fragile — implement manually for rc13)

**Decision**: Vote handling is **consumer-keyset-driven** and emits **per-voter deltas** (no library-side tally). On a raw `pollUpdateMessage`, the Gateway derives a `PollRef` (pollId + group from `pollCreationMessageKey`), calls the consumer's `resolvePollKeyset(ref)`; `null`/throw ⇒ skip the vote (no error). Otherwise it decrypts with `decryptPollVote` using the keyset's `messageSecret` and a **try-both creator/voter JID fallback** (#2342), maps selected option hashes to names via the keyset's `options`, resolves the voter to a canonical `Identity`, and emits a per-voter `PollVote`. The consumer aggregates. The Gateway stores nothing and keeps no durable tally — restart-proof because the keyset lives in the consumer's store.

### Why in-core auto-decryption was disabled (root cause)

This is an **intentional design change**, not a defect — **commit `b7a9f7b` (Rajeh Taher, 2025-03-14)**, message verbatim: *"chats: stop using getMessage to decrypt poll votes — the new expected behavior is to decrypt the new votes yourself like in the Example."* The branch was commented out (not deleted) and tagged `// TODO: make standalone, remove getMessage reference` / `// TODO: Remove entirely`.

- **Primary, maintainer-stated reason (documented fact)**: poll-vote decryption requires the **original poll-creation message's `messageSecret`** (from its `messageContextInfo`). Core could only obtain that by calling the consumer-supplied `getMessage`, i.e. core depended on consumer state to decrypt. The maintainers removed that core→consumer coupling and delegated vote decryption to consumers, who call the still-exported `decryptPollVote` + `getAggregateVotesInPollMessage` themselves. **This confirms the hypothesis that the issue is rooted in decryption needing the original message's key/secret.**
- **Secondary reason it was not simply re-enabled (separately documented; the link is reasoned inference)**: WhatsApp's LID rollout broke the in-core JID derivation. The old code used `getKeyAuthor()` for **both** `pollCreatorJid` and `voterJid` (both resolve to phone-number form), but the protocol now encrypts with the **creator in normalized LID form and the voter in PN form**, so the AES-GCM auth tag fails in LID groups (issues #1678, 2025-08-05; #2158, 2025-12-08). The open *"re-enable with correct LID/PN handling"* fix (#2342, 2026-02-14) shows in-core decryption was still off as of Feb 2026. **Chronology**: the comment-out (Mar 2025) predates the LID breakage (Aug 2025+), so the `getMessage` architectural reason came first; the LID bug is why it has stayed off.
- **Documentation gap**: the v7 migration guide and changelog say **nothing** about this; it is documented only in the commit and the issue tracker. (Caveat: no single maintainer comment ties the comment-out to the LID bug — that link is inference; the `getMessage`-removal rationale is stated directly in the commit message.)

**Implication for the Gateway**: doing decryption ourselves is now the *intended* v7 pattern, not a workaround. Our `poll-vote-decryptor.ts` implements exactly the recommended flow below, with the #2342 LID/PN try-both fallback. The `messageSecret`+options are taken from the in-session message store when the poll-creation message is still cached (the `getMessage`-style path), else from the consumer's keyset (via `resolvePollKeyset`) — the latter being the durable, restart-proof source.

**Verified exported helpers (`lib/Utils`)**:
- `decryptPollVote(vote: proto.Message.IPollEncValue, ctx)` where `ctx = { pollCreatorJid, pollMsgId, pollEncKey: Uint8Array, voterJid }`.
- `getAggregateVotesInPollMessage({ message, pollUpdates }, meId?)` → `{ name: string; voters: string[] }[]`.
- `updateMessageWithPollUpdate(msg, update)` — mutate stored poll message with a `proto.IPollUpdate`.

**rc13 flow (Gateway implementation)**:
1. In `messages.upsert`, detect `msg.message?.pollUpdateMessage` (carries `pollCreationMessageKey` → pollId + group, and `vote = { encPayload, encIv }`). Filter to the authorized group.
2. Build `PollRef { pollId, groupId }`. Resolve the secret+options: **first check the in-memory store** for the poll-creation message (key `${groupId}:${pollId}`) and read `messageContextInfo.messageSecret` + `pollCreationMessage.options`; if absent, call `resolvePollKeyset(ref)` and use `keyset.messageSecret` (base64) + `keyset.options`. If neither yields it (`null`/throw) ⇒ skip (debug-log), never error (FR-021).
3. `decryptPollVote(vote, { pollCreatorJid, pollMsgId: pollId, pollEncKey, voterJid })`, where `pollEncKey` is the resolved secret as raw bytes (the store's `messageContextInfo.messageSecret` is already bytes; `base64Decode(keyset.messageSecret)` when it came from the keyset). `pollMsgId` + creator come from `pollCreationMessageKey`; `voterJid` from the vote's key. **LID gotcha (#1678, #2342)**: try `creator = normalized LID, voter = PN`; on throw, retry `creator = PN, voter = PN` (use `pollCreationMessageKey.fromMe` + `sock.user.lid` to identify our own creator identity). Wrap each attempt in try/catch.
4. Map decrypted selected option **hashes → names** using the resolved `options` (from the store's `pollCreationMessage.options` or the keyset) — this replicates Baileys' own option-hash matching. **Verify the exact hashing/aggregation call against the installed source at implementation time** (FR-031): either hash the option list ourselves, or, when the creation `WAMessage` is in the store, hand it to the exported `getAggregateVotesInPollMessage`.
5. Resolve voter → canonical `Identity` (§10); emit `PollVote { pollId, groupId, voter, selectedOptions, timestamp }`.

**Reporting model**: each `pollUpdateMessage` is the voter's **full current selection** (a change re-sends the whole selection; a withdrawal is empty). The Gateway emits exactly that as a per-voter `PollVote` and keeps **no** cumulative tally — it can't (no storage), and after a restart WhatsApp won't re-deliver unchanged prior votes. The **consumer aggregates** `PollVote`s into a running result; the exported pure `aggregateVotes(votes)` helper does this (last-write-per-voter, identity-canonicalized via `identity-resolver.ts`). Voter JIDs may be `@lid` or `@s.whatsapp.net` → canonicalize.

**`getMessage`**: kept wired to the bounded in-memory store for Baileys send-retries (§2). Poll decryption uses that same store as the first-choice source of the `messageSecret`+options, falling back to the consumer's keyset when the poll-creation message isn't cached; the keyset is what survives a restart.

**Issues & commit**: [commit b7a9f7b — "stop using getMessage to decrypt poll votes"](https://github.com/WhiskeySockets/Baileys/commit/b7a9f7bd6766fd53c6f89a11900533bcd27cb3de) · [#1678](https://github.com/WhiskeySockets/Baileys/issues/1678) · [#2158](https://github.com/WhiskeySockets/Baileys/issues/2158) · [#2342](https://github.com/WhiskeySockets/Baileys/issues/2342) · [#1344](https://github.com/WhiskeySockets/Baileys/issues/1344) · [`decryptPollVote` API](https://baileys.wiki/docs/api/functions/decryptPollVote/).

---

## 8. Deleting messages / polls

**Verified**: `sock.sendMessage(jid, { delete: messageKey })` (revoke for everyone). `messageKey = { remoteJid, fromMe, id, participant? }`. For Gateway-sent messages: `fromMe: true` + stored `id`. (Deleting others' messages needs admin + their `participant` + `fromMe: false`.)

**Failure modes (FR-028)**: WhatsApp enforces a revoke window (historically ~2 days; not guaranteed) — past it, delete is rejected; deleting an unknown/already-gone message no-ops or errors. The Gateway must `try/catch`, report a clear non-fatal failure, and continue (mirrors the MVP's "best-effort delete, log a warning, never block" rule from spec 001 FR-024).

---

## 9. Encryption / decryption

**Verified**: Baileys handles **Signal-protocol E2E automatically** (X3DH, double-ratchet, sender keys, prekeys); the Gateway sends/receives plaintext content and holds the Signal material in memory, surfacing it to the consumer as the opaque credential snapshot (§1). The **only** crypto the Gateway does itself is poll-vote decryption (§7).

**`MessageCounterError` noise (FR-030)**: on reconnect after being offline, WhatsApp re-delivers buffered messages and libsignal raises duplicate/old-counter guards — **benign during offline sync** ("already processed, skipped"). Log at debug; do not crash. Only treat as a real fault if persistent on genuinely **new live** messages (indicates a corrupt session → may need reset). The MVP already notes the startup `MessageCounterError` as unrelated replay noise.

---

## 10. JID vs LID

**Verified (`lib/WABinary/jid-utils.d.ts`)**: servers `s.whatsapp.net` (PN user), `g.us` (group), `lid` (hidden-number identity), `broadcast`, plus `c.us`, `newsletter`, `bot`, `hosted`, `hosted.lid`, `call`.

**Helpers**: `jidNormalizedUser(jid)` (strip device/`:n`), `jidDecode`, `isJidGroup`, **`isPnUser`** (was `isJidUser`), `isLidUser`, `isJidBroadcast`, `isJidNewsletter`, `areJidsSameUser(a,b)`, `jidEncode`.

**Correlation**: v7 carries the counterpart in `WAMessageKey.participantAlt`/`remoteJidAlt` and `GroupMetadata.ownerPn`/`subjectOwnerPn`; live mapping via `sock.signalRepository.lidMapping` (`getLIDForPN`/`getLIDsForPNs`) — and the `lid-mapping` auth key must be persisted (§1).

**Decision (`identity-resolver.ts`, FR-025/FR-026)**: build a canonical-ID resolver — prefer the PN form when available (via `*Alt`/`*Pn` fields or `lidMapping`), normalize with `jidNormalizedUser`, and key all sender/voter state by that canonical ID so one person appearing as LID in votes and PN in chat is never double-counted. Be defensive: always carry both `id` and its counterpart. LID handling in v7 is functional but still stabilizing (the poll-vote bug is the prime example).

---

## 11. Restricting to authorized group(s)

**Decision (`group-filter.ts`, FR-017/FR-018)**: filter `messages.upsert` (`type === 'notify'` only) and any vote handling by `remoteJid ∈ authorizedGroups`, guarded with `isJidGroup`. For poll votes, correlate on the **poll-creation message's** `remoteJid` (the group), not the vote payload. Explicitly ignore `status@broadcast`, newsletters, and DMs.

---

## Version / platform summary

- **Status**: `7.0.0-rc13` (RC, mid-refactor). **Pin exactly.** The commented-out poll-decrypt block proves the RC is in flux — re-verify on bump.
- **Node**: 20+ (project: 22). **Module**: ESM-only.
- **v6→v7 breaking changes relevant here**: ESM migration; `isJidUser`→`isPnUser`; `Contact` reshaped (`id`/`phoneNumber`/`lid`); `WAMessageKey` gains `participantAlt`/`remoteJidAlt`; auth store must handle `lid-mapping`/`device-list`/`tctoken`; `onWhatsApp` no longer returns LIDs (use `getLIDForPN`); LID/PN mapping via `sock.signalRepository.lidMapping`; in-memory store removed from core (bring your own).

**Verified source paths**: `node_modules/@whiskeysockets/baileys/lib/Types/{Auth,Message,Events,GroupMetadata,Socket,State,index}.d.ts`, `lib/Utils/{auth-utils,messages,process-message}.{d.ts,js}`, `lib/WABinary/jid-utils.d.ts`, `lib/Socket/{messages-send,groups,socket}.d.ts`, `WAProto/index.d.ts`.

**Two things to re-confirm at implementation time**: (a) whether the pinned version has re-enabled built-in poll-vote decryption (rc13 has it off — build manual decryption, treat any auto-emit as a bonus); (b) the exact LID/PN ordering `decryptPollVote` needs for the authorized group (use the #2342 try-both fallback).

**Docs root**: https://baileys.wiki/docs/intro/ · **Migration**: https://baileys.wiki/docs/migration/to-v7.0.0/ · **Repo**: https://github.com/WhiskeySockets/Baileys
