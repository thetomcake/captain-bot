---
name: whatsapp-gateway-spec
description: Decision to build an in-house Baileys wrapper library (spec 002) instead of adopting any third-party WhatsApp wrapper or the official API
metadata:
  type: project
---

After thorough research (2026-06-13), the team rejected all third-party WhatsApp options and chose to build a **standalone in-house Gateway library** wrapping Baileys, specced at `specs/002-whatsapp-gateway/`.

**Why each alternative was rejected:**
- Official WhatsApp Cloud API: no native polls / no vote-readback, and its Groups API only manages business-created ≤8-person invite-only groups — can't monitor an existing team group.
- whatsappi: abandoned (2022), pins EOL Baileys, no polls.
- Evolution API: heavy sidecar (Docker+Postgres+Redis), poll votes not reliably exposed (#1644), inverts the minimal-infra philosophy.
- WPPConnect / whatsapp-web.js / venom / open-wa: Puppeteer/Chromium (~400MB), and poll-vote-in-groups is fragile (wwebjs #3796) or undocumented; open-wa is paywalled.
- Every viable path is the unofficial WhatsApp Web protocol → ban risk is unavoidable and already accepted.

**How to apply:** The Gateway is a separate module that must NOT touch current MVP code; manually testable via one CLI entry point per action (no shared arg-parser); fast tests at its own interface boundary. Cutting the MVP over and deleting its direct Baileys usage is deferred to avoid polluting history. See [[baileys-pinned-version-fidelity]] for the implementation discipline.

**Storage-agnostic design (key decision):** the library persists NOTHING. Auth = opaque `WhatsAppCredentials` snapshot returned via `onCredentialsUpdate`/`getCredentials`, passed back via constructor. Polls = `sendPoll` returns a `PollKeyset` (base64 messageSecret + options) the consumer stores; on each vote the library calls a consumer `resolvePollKeyset(ref)` callback (null ⇒ skip, no error) to get the secret, decrypts itself, and emits per-voter `PollVote` deltas — the consumer aggregates (no library tally; restart-proof because state lives in the consumer's store).
