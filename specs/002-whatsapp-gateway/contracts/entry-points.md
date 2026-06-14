# Contract: Manual Entry Points (one per action)

Per FR-004, each action is a **separate single-purpose script** under `src/whatsapp-gateway/bin/`. There is **no shared CLI framework and no argument parser** — each script imports only the Gateway's public surface (`../index.js`), reads its inputs from inline constants and/or environment variables, performs exactly one action, prints human-readable results to stdout (errors to stderr), and exits.

Because the Gateway is **storage-agnostic**, the entry points act as the *consumer* that persists credentials. Each script keeps the opaque `WhatsAppCredentials` snapshot in a **local JSON file it owns** (`WA_CREDS_FILE`, default `./.wa-creds.json`): it reads the file (if present) and passes the snapshot to `config.credentials`, and writes the file in `config.onCredentialsUpdate`. **This filesystem usage lives in the entry-point (the consumer), not in the library** — the library still touches no disk.

Run during development with `tsx`, e.g. `WA_CREDS_FILE=./.wa-creds.json npx tsx src/whatsapp-gateway/bin/connect.ts`. Inputs are env vars (no flags).

| Script | Action | Inputs (env / inline) | Expected output | Validates |
|--------|--------|-----------------------|-----------------|-----------|
| `connect.ts` | Connect & stay connected | `WA_CREDS_FILE` | Prints QR (first run), then `connected`; on re-run, `connected` with no QR | US1 / FR-005,006,009,010,011 |
| `force-reauth.ts` | Force fresh login | `WA_CREDS_FILE` | Calls `forceReauth()`, **deletes** the creds file, prints confirmation; next `connect` shows a QR | US1 / FR-007 |
| `list-groups.ts` | List groups | `WA_CREDS_FILE` | Table of `id`, `name`, `addressingMode`; empty notice if none | US4 / FR-019 |
| `send-message.ts` | Send text | `WA_CREDS_FILE`, `WA_GROUP_ID`, `WA_TEXT` | Prints returned `MessageRef`; message visible in group | US2 / FR-013,016 |
| `listen.ts` | Print inbound | `WA_CREDS_FILE`, `WA_GROUP_ID` | Long-running; prints each authorized-group `notify` message (sender, text, ts); ignores other chats/echoes | US2 / FR-014,015,017 |
| `send-poll.ts` | Post a poll | `WA_CREDS_FILE`, `WA_POLL_KEYS_FILE`, `WA_GROUP_ID`, `WA_POLL_QUESTION`, `WA_POLL_OPTIONS` (comma-separated, 2–12) | Prints poll `MessageRef`; **appends the returned `PollKeyset` to `WA_POLL_KEYS_FILE`**; poll visible in group; rejects bad option counts | US3 / FR-020,021 |
| `watch-votes.ts` | Track votes | `WA_CREDS_FILE`, `WA_POLL_KEYS_FILE`, `WA_GROUP_ID` | Long-running; supplies `resolvePollKeyset` from `WA_POLL_KEYS_FILE`; prints each decrypted **per-voter selection** (voter + options) plus a running aggregate computed in-script via `aggregateVotes`; correct under vote changes & LID groups; skips votes with no stored keyset | US3 / FR-021,022,023,024,025,026 |
| `delete-message.ts` | Delete a message/poll | `WA_CREDS_FILE`, `WA_GROUP_ID`, `WA_MESSAGE_ID` | Prints `DeleteOutcome`; on rejection prints a clear non-fatal reason | US5 / FR-027,028 |

## Conventions
- Each script constructs:
  ```ts
  const creds = readJsonIfExists(WA_CREDS_FILE);            // consumer-side persistence
  const gw = new WhatsAppGateway({
    authorizedGroups: [WA_GROUP_ID],
    credentials: creds,
    onCredentialsUpdate: (c) => writeJson(WA_CREDS_FILE, c), // store the opaque snapshot
  });
  gw.onQR(renderQr);                                         // qrcode-terminal, in the script
  await gw.connect();
  // …do the one action; one-shot scripts exit, listen/watch-votes stay up until Ctrl-C…
  ```
- Scripts share **no** common runner/parser module — duplicating a few lines of setup is intentional, to keep each entry point trivially readable and independent (FR-004).
- Inputs are env/inline only; an absent required input → clear stderr message + non-zero exit.
- `force-reauth.ts` additionally deletes `WA_CREDS_FILE` after `forceReauth()` so the next run re-pairs.
- Poll keysets are persisted consumer-side too: `send-poll.ts` appends the `PollKeyset` returned by `sendPoll` to `WA_POLL_KEYS_FILE`; `watch-votes.ts` wires `resolvePollKeyset: (ref) => readKeysetFor(ref.pollId)` from that file and returns `null` (⇒ skip, no error) when the poll is unknown. The library still writes nothing to disk.
- QR rendering (`qrcode-terminal`) lives in the entry points, not the library.
