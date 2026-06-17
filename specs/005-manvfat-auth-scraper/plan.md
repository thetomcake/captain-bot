# Implementation Plan: Authenticated MAN v FAT Fixture Scraping

**Branch**: `005-manvfat-auth-scraper` | **Date**: 2026-06-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-manvfat-auth-scraper/spec.md`

## Summary

MAN v FAT now gates club fixture data behind a WordPress login, so the existing unauthenticated
`axios.get` in `src/scraping/fixture-scraper.ts` receives a page whose fixture tables are present
in markup but empty of fixtures (anon: 0 week headers; authed: 14 — see `research.md`).

**Technical approach**: contain the fix in the **fetch layer** behind the existing
`IFixtureScraper` boundary. A `ManvfatSession` helper performs the verified WordPress form-POST
login (`/dash/?wpe-login=true` with `log`/`pwd`/`testcookie` + a `wordpress_test_cookie` request
cookie) into a `tough-cookie` `CookieJar`. The jar is serialized, **AES-256-GCM-encrypted**, and
**persisted on the team row** (`teams.manvfat_cookie`) for reuse; credentials live on the same row
(`manvfat_username` plaintext, `manvfat_password` encrypted). On fetch, the scraper attaches the
jar's cookie header; if the response is **not authenticated** (no WordPress `logged-in` class on
`<body>` — Finding 5) it re-logs-in **at most once**, persists the fresh jar, and retries.
Repeated failure to authenticate raises a distinct `AuthError`. The trigger is the auth marker,
**not** fixture presence, so an authenticated-but-empty page (off-season) returns as a valid empty
result rather than being mistaken for logged-out (FR-005a).

**Parsing is unchanged** (FR-006): the authenticated HTML matches the parser's current selectors
exactly (research.md Finding 4). `scrapeFixtures()` and the `IFixtureScraper` interface are
untouched, so `FixtureService`, all consumers, and every existing test mock keep working. No
headless browser; one lightweight new dependency (`tough-cookie`).

**Deliberately simple**: credentials/session are per-team columns — no `leagues` table, no
multi-team-per-league fixture sharing (explicitly deferred, spec "Out of Scope").

## Technical Context

**Language/Version**: TypeScript (strict, no `any`) on Node.js 22.x. ESM/NodeNext; `.js`
extensions on relative imports; `#src/*` subpath imports (constitution III).

**Primary Dependencies**: `axios` (existing) for HTTP, `cheerio` (existing) for the auth-state
check (`$('body').hasClass('logged-in')`) + parsing, `p-queue` + `withRetry` (existing) for rate limiting/retry, `drizzle-orm` +
`drizzle-kit` (existing) for the migration, Node built-in `crypto` for AES-256-GCM. **One new
runtime dependency**: `tough-cookie` (pure-JS cookie jar; no browser). `axios-cookiejar-support`
explicitly NOT adopted (manual `getCookieStringSync`/`setCookieSync` keeps axios usage explicit).

**Storage**: Three new nullable columns on the existing `teams` table (`manvfat_username`,
`manvfat_password` [encrypted], `manvfat_cookie` [encrypted serialized jar]) via one Drizzle
migration. No new tables, no backfill. The DB remains gitignored (`*.db`). Encryption key from
`MANVFAT_CREDENTIAL_KEY` (`.env`, never committed).

**Testing**: Vitest, service-boundary philosophy (`tests/README.md`). New **unit** tests cover
only pure logic, no live HTTP: `isAuthenticated()` (incl. the off-season authed-but-empty case),
`Set-Cookie` → jar parsing, `crypto`
encrypt/decrypt round-trip + bad-key failure, and the recovery-loop control flow via injected
fetch/login seams. The live login handshake is validated via `quickstart.md` (ratified
network/interactive exclusion) — NOT by faking axios (would only re-assert constants and miss the
real failure mode: the site changing). Library internals (axios/cheerio/tough-cookie) not tested
(constitution "What NOT to Test").

**Target Platform**: Single Linux/macOS server, single operator, long-running daemon + CLI.

**Project Type**: Single-project CLI/library.

**Performance Goals**: Not throughput-bound. Cookie reuse → ≈one login per ~14 days (SC-002);
scraping cadence/rate limits unchanged.

**Scale/Scope**: Single account, single club page per run, one team (multi-team deferred).

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. CLI-First | ✅ PASS | No new surface; `fixtures`/`sync`/`init`/`daemon` gain auth transparently. Credentials seeded via env at `init`, consistent with `CLUB_URL`. |
| II. Test-First (NON-NEGOTIABLE) | ✅ PASS | Tests authored before impl for the **testable** units (auth-state detection incl. off-season, cookie parse, crypto round-trip, recovery loop via seams). Live login validated via quickstart (ratified network exclusion); library internals not tested. |
| III. TypeScript | ✅ PASS | Strict, ESM/NodeNext, `.js` imports, `#src/*`. New `AuthError` + `crypto` util typed; no `any`. |
| Service-boundary mocking | ✅ PASS | `IFixtureScraper` preserved; auth lives *inside* `DefaultFixtureScraper`/`ManvfatSession`, below the mocked boundary (FR-008). |
| Secrets handling | ✅ PASS | Password + cookie encrypted at rest (AES-256-GCM); key in env only; secrets/key never logged (FR-007). DB gitignored. |

**Gate result**: PASS — one justified new dependency (`tough-cookie`, lightweight); no Complexity
Tracking entries required.

## Project Structure

### Documentation (this feature)

```
specs/005-manvfat-auth-scraper/
├── spec.md
├── plan.md          # this file
├── research.md      # verified auth handshake + persistence/crypto/dep decisions
├── data-model.md    # teams columns + session/crypto + state machine
├── quickstart.md    # live validation guide
└── contracts/
    ├── manvfat-session.md   # session helper contract (jar + DB persistence + crypto)
    └── fixture-scraper.md   # IFixtureScraper boundary (unchanged) + fetchHtml auth flow
```

### Source (impacted)

```
src/
├── scraping/
│   ├── fixture-scraper.ts        # MODIFIED: DefaultFixtureScraper now REQUIRES a ManvfatSession
│   │                             #           (always-authenticated; no unauthenticated path) +
│   │                             #           at-most-once re-login; NEW isAuthenticated(). Parser UNCHANGED.
│   ├── manvfat-session.ts        # NEW: login POST, tough-cookie jar, encrypt/persist to team row
│   └── request-queue.ts          # NEW: shared per-host rate limiter (p-queue moved out of
│                                  #      fixture-scraper); login POST + page GET both enqueue per-request
├── database/
│   └── schema.ts                 # MODIFIED: teams += manvfat_username/password/cookie columns
├── services/
│   └── fixture-service.ts        # MODIFIED: build a team-scoped DefaultFixtureScraper per call
│                                 #           (so fetchHtml has the team's creds + persist callback)
├── config/
│   └── env.ts                    # MODIFIED: load + validate MANVFAT_CREDENTIAL_KEY (and seed creds)
├── cli/commands/init.ts          # MODIFIED: seed manvfat_username/password from env onto the team
├── utils/
│   ├── crypto.ts                 # NEW: AES-256-GCM encryptSecret/decryptSecret (key from env)
│   └── errors.ts                 # MODIFIED: add AuthError
└── types/{config,entities}.ts    # MODIFIED: Team gains manvfat fields; env gains credential key
drizzle/<migration>.sql           # NEW: add three nullable columns to teams
.env.example                      # MODIFIED: document MANVFAT_USERNAME/PASSWORD/CREDENTIAL_KEY
```

## Phase 0 — Outline & Research

**Status**: ✅ Complete → [research.md](./research.md). Handshake, jar-based persistence (single
encrypted column), `tough-cookie` dependency, AES-256-GCM key handling, and the auth-state signal
all resolved. No `NEEDS CLARIFICATION` remain.

## Phase 1 — Design & Contracts

**Status**: ✅ Complete.

- **Data model** → [data-model.md](./data-model.md): `teams` columns, config/env values, the
  `ManvfatSession` runtime helper, encryption format, and state transitions.
- **Contracts** → [contracts/](./contracts/): `ManvfatSession` helper; the unchanged
  `IFixtureScraper` boundary + the `fetchHtml` auth flow.
- **Quickstart** → [quickstart.md](./quickstart.md): live validation (configure key + creds →
  init seeds team → scrape → verify full fixtures → verify cookie reuse → verify re-login on
  invalidated cookie → verify encryption-at-rest + no secret logging).
- **Agent context**: `CLAUDE.md` SPECKIT block points at this plan.

## Phase 2 — Implementation Outline (for `/speckit-tasks`)

Test-first ordering, per `tasks.md`:

1. **Migration + schema**: add `manvfat_username/password/cookie` columns to `teams`.
2. **Crypto util + key config**: `crypto.ts` (AES-256-GCM) + `MANVFAT_CREDENTIAL_KEY` loading/validation.
3. **`AuthError`** in `errors.ts`.
4. **Auth-state detector** (pure): `isAuthenticated(html)` via `logged-in` body class.
5. **`ManvfatSession`**: jar-based login, encrypt/persist to team row, cookie-header build.
6. **Scraper + service wiring**: team-scoped `DefaultFixtureScraper`; at-most-once re-login.
7. **`init` seeding** of credentials from env.
8. **Live validation**: run `quickstart.md`.

## Complexity Tracking

None — no constitutional gate violations. The single new dependency (`tough-cookie`) is
lightweight and justified by robust cookie handling; the `leagues` remodel was considered and
**deliberately deferred** (spec "Out of Scope") to avoid premature complexity.
