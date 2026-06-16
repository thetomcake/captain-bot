---
name: project-offline-catch-up
description: Feature 004 offline catch-up — root cause of missed votes/messages after reconnect, and the agreed fix scope
metadata:
  type: project
---

Feature `004-offline-catch-up` (spec written 2026-06-16, status Draft, ready for `/speckit-plan`). Alters the WhatsApp Gateway ([[whatsapp-gateway-spec]]). See also [[baileys-pinned-version-fidelity]] (verify Baileys against installed source).

**Root cause (investigated, evidence-backed):** When the daemon goes offline (e.g. internet outage) and reconnects, WhatsApp DOES re-deliver the missed messages and poll-vote updates from the server's per-device offline buffer — but Baileys tags every offline-flushed item `type: 'append'` (rule `node.attrs.offline ? 'append' : 'notify'` at `node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js:1432`, installed 7.0.0-rc13). The Gateway's `isNewInbound` (`src/whatsapp-gateway/messages/message-mapper.ts`) dispatches only `type === 'notify'` and drops all `append` in `gateway.ts handleMessagesUpsert` ("skipping non-live item") BEFORE the authorized-group/poll-vote routing. So catch-up arrives and is silently discarded. This is a Gateway design collision, NOT a WhatsApp limitation. Baileys docs (baileys.wiki) do NOT document the notify/append-vs-offline mapping — confirmed only via installed source.

**Why append was dropped originally:** it also carries echoes of the Gateway's own programmatic sends + history backfill (FR-015).

**Agreed fix (the spec's premise):** use the FR-034 at-most-once claim store (003 Phase 9, keyed on composite `(remoteJid, id)`) — claim our own outbound sends at send time so their echoes are deduped — then treat `append` like `notify`, reducing/removing the notify-only filter to just the authorized-group check.

**Scope decision (2026-06-16): Option A only** — handle the offline catch-up flush. `syncFullHistory` / full older-history sync is OUT OF SCOPE (separate `messaging-history.set` channel; heavier; undocumented whether it even carries poll-vote updates). Recorded as a future enhancement. Operator initially thought syncFullHistory pulled "everything since last connection" — it does not; the offline flush is what recovers the outage window.
