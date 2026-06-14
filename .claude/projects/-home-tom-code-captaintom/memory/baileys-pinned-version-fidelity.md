---
name: baileys-pinned-version-fidelity
description: Baileys behaviour must be verified against the exact installed version's source, not docs/memory — prior AI got poll handling badly wrong
metadata:
  type: feedback
---

When working with Baileys (`@whiskeysockets/baileys`) in this project, conform exactly to the official docs **for the pinned version** and verify against the actually-installed source in `node_modules`; never rely on remembered or assumed APIs/behaviour. A prior attempt got this "massively wrong."

**Why:** Baileys v7 is still RC and mid-refactor; docs describe intended behaviour the installed build may disable. Verified facts in the installed `7.0.0-rc13`:
- Built-in poll-vote auto-decryption is **intentionally commented out** in `lib/Utils/process-message.js` (~L576–624) — commit `b7a9f7b` (2025-03-14) "stop using getMessage to decrypt poll votes; decrypt yourself like in the Example." Reason: core needed the consumer's `getMessage` to recover the poll's `messageSecret`; they removed that coupling. It stayed off because the LID rollout broke creator/voter JID derivation (#1678/#2158/#2342). So `messages.update` does NOT auto-emit decrypted `pollUpdates`. Must decrypt manually via exported `decryptPollVote` + `getAggregateVotesInPollMessage`, recovering `messageSecret` from the stored poll-creation message (so `getMessage` on `makeWASocket` is still mandatory), with a try-both LID/PN creator/voter fallback (#2342).
- `isJidUser` was renamed to `isPnUser`. Baileys is ESM-only. Requires Node 20+.
- `WAMessageKey` gained `participantAlt`/`remoteJidAlt`; use these + `jidNormalizedUser` to correlate LID↔PN. LID poll-vote decryption needs the #2342 try-both (creator/voter) JID fallback.

**How to apply:** Before coding any Baileys behaviour, read the installed type defs/compiled source and the version-matched docs; treat installed source as authoritative on conflict. Captured as FR-031 in [[whatsapp-gateway-spec]].
