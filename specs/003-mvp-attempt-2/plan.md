# Implementation Plan: MAN v FAT Captain Stats Tool (MVP, Gateway-native)

**Branch**: `003-mvp-attempt-2` | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-mvp-attempt-2/spec.md`

## Summary

Re-deliver the MAN v FAT captain-stats MVP (fixtures → polls → stat capture → per-season
storage/viewing) on top of the **completed in-repo WhatsApp Gateway library**
(`src/whatsapp-gateway/`, spec 002). The MVP reaches WhatsApp **exclusively** through the
Gateway's small, stable, typed public surface (`src/whatsapp-gateway/index.ts`) and never
touches Baileys (FR-006, SC-011).

The **foundational first step is a cutover**: delete the MVP's direct-Baileys WhatsApp code
(`src/whatsapp/client.ts`, `auth.ts`, the Baileys imports in `connect.ts`/`types/whatsapp.ts`)
and replace it with a **thin DB-backed seam** that constructs a `WhatsAppGateway`, wires
credential persistence (opaque snapshot) and poll-keyset resolution to the SQLite database,
and exposes a narrow port (`IWhatsAppGateway`) that services and the test fake both implement.
Everything WhatsApp-facing (poll posting, vote capture, stat-message intake, group discovery,
QR rendering) is then rebuilt or reworked against that seam; the non-WhatsApp domain (scraping,
fixtures, seasons, persistence, stat NLP, CLI) **reuses the design from `001-mvf-captain-stats`**
(see [research.md](./research.md)).

Per-story disposition (decided here, per the spec's "no existing code trusted" instruction):

| Story | WhatsApp? | Disposition | Why |
|-------|-----------|-------------|-----|
| **US1** View fixtures | No | **Review + migrate (light)** | Scraper/fixture/season code is WhatsApp-free; re-verify acceptance, confirm it doesn't import removed code. |
| **US2** Post polls + capture votes | Yes | **Rework onto Gateway** | `poll-service` is bound to the deleted `IWhatsAppClient`; rebuild on `sendPoll`→keyset persist + `onPollVote`→persist each delta (replace-by-voter, canonical identity) as the durable DB tally. Posting is **manually triggered** by an `!postpoll` group message (FR-029) or the `poll` CLI — no post-game cron; re-trigger force-replaces (FR-027). |
| **US3** Capture stats from chat | Yes (receive) | **Rebuild** | No stat parser or stat service exists today; `message-handler` only logs. |
| **US4** View stats | No | **Rebuild (view-only)** | `stats` command is advertised in help but unrouted/unimplemented. Captain-side stat *correction* is **out of scope** (FR-024) — stored stats change only via a later player message (field-level override, FR-019); the `stats` command is view-only. |
| **US5** Season transition | No | **Implement + review** | `SeasonService.shouldCreateNewSeason()` is a `return false` placeholder. |

## Technical Context

**Language/Version**: TypeScript (strict, no `any`) on Node.js 22.x. ESM with NodeNext
resolution; `.js` extensions on relative imports; `#src/*` subpath imports (per constitution III).

**Primary Dependencies**:
- **In-repo WhatsApp Gateway** (`src/whatsapp-gateway/`, spec 002) — the MVP's *only* WhatsApp
  integration point, imported from `index.ts`. Baileys is a transitive dependency **of the
  Gateway only**; no MVP source file may import it (SC-011).
- `drizzle-orm` + `better-sqlite3` — persistence (SQLite).
- `axios` + `cheerio` — static HTML fixture scraping (the **only** scraping approach; Playwright
  is excluded entirely — its dependency is to be removed from `package.json`).
- ~~`croner`~~ — **removed**. With on-demand fetching and the `!postpoll` trigger replacing both
  crons (no daily fixture check, no post-game poll job), the daemon schedules nothing; the `croner`
  dependency is dropped from `package.json` alongside Playwright.
- `qrcode-terminal` + `qrcode` — MVP-side QR rendering (terminal + saved PNG) from the Gateway's
  surfaced QR value (FR-007).
- `minimist` — CLI arg parsing. `p-queue` — already used by the Gateway's own limiter.

**Storage**: SQLite via Drizzle ORM. Tests use a real **in-memory** (`:memory:`) database.
The MVP persists the Gateway's **opaque credential snapshot** and each poll's **keyset**
(`messageSecret` + options) in its own tables (the Gateway stores nothing).

**Testing**: Vitest. Service-boundary mocking only (`tests/README.md`): a **fake fixture
scraper** (`IFixtureScraper`) and a **fake Gateway** (`IWhatsAppGateway`) — never a Baileys/axios/
cheerio/drizzle internal mock. Real in-memory DB + real parsers with static HTML fixtures.
Stat NLP and vote aggregation are pure and tested directly. Full suite target **< 10 s** (SC-010).

**Target Platform**: Single Linux/macOS server, single operator, long-running `daemon`.

**Project Type**: Single-project CLI (`captain-stats <command>`).

**Performance Goals**: Fixtures viewable < 5 s (SC-001); `!postpoll` responds (poll posted, or a
problem reply) within 30 s (SC-002); stat capture ≥ 80% on clear messages, < 5% false positives
(SC-003/SC-004); test suite < 10 s (SC-010). Not throughput-bound.

**Constraints**:
- No MVP file imports Baileys (verified by a guard test, SC-011); all WhatsApp behaviour via the
  Gateway port. Connection lifecycle, reconnection/backoff, single-group restriction, rate
  limiting, identity canonicalization, and best-effort delete are **owned by the Gateway** — the
  MVP composes, never re-implements them.
- Static parsing only (Axios + Cheerio); no headless browser.
- UK timezone default (`Europe/London`).
- Conservative stat capture (70% confidence threshold); no weight values/BMI (FR-021).

**Scale/Scope**: One team, ~20–30 games/season, ~10–15 players, 5+ retained seasons; low message
volume; one authorized WhatsApp group.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. CLI-First ✅ PASS
Every capability is a `captain-stats` subcommand (`init`, `fixtures`, `sync`, `stats`, `poll`,
`connect`, `daemon`, `seasons`) reading args/env, writing human output to stdout and errors to
stderr, with `--json` where it aids scripting. No interactive prompt libraries; QR is rendered to
the terminal and a file.

### II. Test-First (NON-NEGOTIABLE) ✅ PASS
Tests are written before implementation for each story and verified failing first. Mocking is at
the MVP's own service boundaries — `IFixtureScraper` and `IWhatsAppGateway` — per `tests/README.md`;
no library-internal mocking (no `vi.mock('@whiskeysockets/baileys')`, axios, cheerio, drizzle).
Interactive WhatsApp paths (QR pairing, live votes) are validated via the Gateway's own manual
`bin/` entry points + quickstart, not the automated suite (same ratified exclusion as spec 002).
Real in-memory DB; pure NLP/aggregation tested directly.

### III. TypeScript ✅ PASS
Strict, no `any`; NodeNext ESM; `.js` extensions; `#src/*` subpath imports (no `../../../`).
The Gateway already hides all Baileys types behind its public surface, so no Baileys type enters
MVP code.

### IV. Security-First (NON-NEGOTIABLE) ✅ PASS
The opaque credential snapshot is persisted only in the MVP's local DB, never in tests or commits
(`.wa-creds`/`*.db`/`.env` are git-ignored). The Gateway enforces the single-authorized-group
restriction and conservative rate limiting. No test uses real credentials or bypasses auth. Stat
capture stores only weight *direction*, never weight/BMI values (FR-021). Input from chat is
treated as untrusted and parsed by bounded regex with range validation.

**Result: All gates pass. Complexity Tracking is empty.**

## Project Structure

### Documentation (this feature)

```text
specs/003-mvp-attempt-2/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 — reuse map (001) + Gateway-cutover decisions
├── data-model.md        # Phase 1 — schema changes (credentials, keyset, canonical identity)
├── quickstart.md        # Phase 1 — per-story validation guide
├── contracts/
│   ├── gateway-port.md   # MVP↔Gateway seam: IWhatsAppGateway + DB-backed callbacks
│   └── cli-commands.md   # captain-stats command surface (args, exit codes, output)
├── checklists/
│   └── requirements.md  # (from /speckit-specify)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── cli/
│   ├── index.ts                  # Command router (add `stats`, `seasons` routes)
│   ├── commands/
│   │   ├── init.ts               # REUSE — config + DB bootstrap
│   │   ├── fixtures.ts           # US1 review+migrate
│   │   ├── sync.ts               # US1 review+migrate (manual fixture refresh)
│   │   ├── stats.ts              # US4 NEW — view stats (view-only; no captain-side correction, FR-024)
│   │   ├── seasons.ts            # US4/US5 NEW — season history
│   │   ├── poll.ts               # US2 REWORK — post via Gateway port
│   │   ├── connect.ts            # REWRITE — Gateway.connect()+listGroups(); MVP QR render
│   │   └── daemon.ts             # REWORK — Gateway events only, NO crons (onMessage→`!postpoll`+stat capture, onPollVote→tally, onConnectionChange→log)
│   └── output/                   # REUSE — formatters
├── whatsapp/                     # THE SEAM (replaces deleted Baileys code)
│   ├── gateway-port.ts           # NEW — IWhatsAppGateway port (real Gateway satisfies it)
│   ├── gateway-factory.ts        # NEW — build WhatsAppGateway wired to DB-backed callbacks
│   ├── credentials-store.ts      # NEW — load/save opaque snapshot (FR-008)
│   ├── keyset-store.ts           # NEW — persist/resolve poll keysets (FR-012/FR-014)
│   ├── poll-presenter.ts         # KEEP (de-Baileyed) — poll question/options formatting
│   └── event-router.ts           # REWORK of message-handler — intercept `!postpoll` command FIRST, then route onMessage→stat capture / onPollVote→tally
│   #  DELETED: client.ts, auth.ts, message-handler.ts, poll-manager.ts (Baileys-bound)
├── services/
│   ├── fixture-service.ts        # REUSE — scrape/store fixtures
│   ├── season-service.ts         # US5 — implement shouldCreateNewSeason() (currently placeholder)
│   ├── poll-service.ts           # US2 REWORK — keyset persist + durable per-voter tally in DB (canonical id)
│   └── stat-service.ts           # US3 NEW — capture/merge stats (+ US4 read queries)
├── stats/
│   └── stat-extractor.ts         # US3 NEW — pure regex + confidence scoring (reuse 001 design)
├── scraping/fixture-scraper.ts   # REUSE
├── database/
│   ├── schema.ts                 # CHANGE — drop authStates; add gatewayCredentials; poll.whatsappMessageId→pollMessageId +messageSecret/groupId; whatsappUsers→canonicalId(+pn/lid)
│   ├── client.ts / migrate.ts    # REUSE
├── config/env.ts                 # CHANGE — AUTHORIZED_GROUP_ID required for daemon; drop Baileys-era knobs as needed
├── types/
│   ├── entities.ts               # CHANGE — AuthState→GatewayCredential; identity fields
│   └── whatsapp.ts               # REWRITE — drop Baileys `proto` import; keep ExtractedStats; re-export Gateway types via port
└── utils/                        # REUSE — logger, retry, errors (rate-limiter now Gateway-owned)

tests/
├── helpers/
│   ├── fake-gateway.ts           # NEW — implements IWhatsAppGateway (replaces mock-whatsapp.ts)
│   ├── mock-scraper.ts           # REUSE
│   ├── test-database.ts          # REUSE
│   └── test-config.ts            # REUSE
├── unit/
│   ├── stats/stat-extractor.test.ts        # US3 NEW
│   └── whatsapp/poll-presenter.test.ts     # replaces poll-manager.test.ts
└── integration/
    ├── fixtures/…                # US1 review
    ├── seasons/season-transition.test.ts   # US5 NEW
    ├── stats/stat-capture.test.ts          # US3 NEW
    ├── stats/stats-command.test.ts         # US4 NEW (view-only)
    └── whatsapp/poll-service.test.ts       # US2 rewrite against fake-gateway
    └── whatsapp/no-baileys-import.test.ts  # SC-011 guard
```

**Structure Decision**: Keep the existing single-project CLI layout. The Baileys-coupled
`src/whatsapp/*` modules are deleted and the directory is repurposed as the **Gateway seam**: a
narrow `IWhatsAppGateway` port plus a factory that wires the real `WhatsAppGateway` to DB-backed
credential and keyset stores. Services depend on the port (not on the concrete Gateway and never
on Baileys), so the fake Gateway in tests is a drop-in — preserving the service-boundary mocking
philosophy. The non-WhatsApp domain stays where it is and is reused.

## US6 — View Poll Responses (`fixtures --show-responses`) — added 2026-06-16

A read-only addendum to the implemented MVP. It surfaces the poll responses US2 already captures
(`polls` → `poll_responses` → `whatsapp_users`) under each fixture in the existing `fixtures` view.
**No schema change** — all required data already exists; see the data-model addendum. No
WhatsApp/Gateway interaction (it never connects), so no fake-Gateway wiring is needed in tests.

**Disposition:** Implement (small, additive, view-only). Mirrors the US4 `stats` view's shape:
service read method → pure formatter → command flag → router wiring → integration test.

**Design (matches existing conventions):**

| Layer | Change |
|-------|--------|
| `services/poll-service.ts` | **ADD** read method `getResponsesForGames(gameIds: number[]): Promise<Map<number, GamePollResponses>>` — left-join `polls`→`poll_responses`→`whatsapp_users` for the given games. Returns, per game with a poll, `{ pollQuestion, responses: PollResponseLine[] }` where `PollResponseLine = { canonicalId, displayName, selectedOption, respondedAt }`. Games with no poll are absent from the map (the formatter treats a missing entry as "no poll posted"); a poll with no votes yields an empty `responses` array. Ordered by poll-option order (Yes/No/Maybe via `getPollOptions()`) then `displayName`. One row per canonical identity is guaranteed by the existing `unique(poll_id, user_id)` constraint (FR-013/SC-008). |
| `cli/output/formatters.ts` | **ADD** `formatFixturesWithResponsesTable(season, fixtures, responsesByGame)` and `formatFixturesWithResponsesJSON(season, fixtures, responsesByGame)`. The existing `formatFixturesTable`/`formatFixturesJSON` are **left untouched** (no-flag path unchanged, AS-5/FR-030). Human output reuses the fixtures table, then indents each fixture's responses (`  Name    <choice>`); fixtures with no poll print `  (no poll posted)`, polls with no votes print `  (no responses yet)`. Name falls back to `canonicalId` (AS-4), reusing the `displayName ?? canonicalId` idiom from the stats formatter. JSON adds a `poll` field per fixture: `null`, or `{ question, responses: [{ name, choice }] }`. |
| `cli/commands/fixtures.ts` | When `options.showResponses`, after loading fixtures call `new PollService(...).getResponsesForGames(fixtures.map(f => f.id))` and route to the new formatters; otherwise the current path is unchanged. Reuses existing exit codes (`1` no fixtures, `3` error). |
| `cli/index.ts` | Add `show-responses` to the `fixtures` boolean flags, pass `showResponses: parsed['show-responses']`, and add the `--show-responses` line to the `fixtures` help text. |
| `tests/integration/fixtures/show-responses.test.ts` | **NEW** — real in-memory DB, real services (no Gateway). Seed: a game with a poll + several votes (incl. a user with `displayName = null`), a poll with zero votes, and a fixture with no poll. Assert: per-fixture grouping, Yes/No/Maybe ordering, canonical-id fallback, "no poll"/"no responses" rendering, `--json` shape, and that plain `fixtures` output is byte-for-byte unchanged (AS-5). |

**Constitution re-check (US6):** CLI-First ✅ (flag on an existing subcommand, stdout/`--json`).
Test-First ✅ (integration test seeded against the in-memory DB at the service boundary, written
first). TypeScript ✅ (no `any`; new types exported from `poll-service.ts`). Security ✅ (read-only;
no new inputs, credentials, or chat parsing). No new dependencies; no constitution violations.

## Complexity Tracking

> No constitution violations — section intentionally empty.
