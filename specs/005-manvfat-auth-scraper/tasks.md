---
description: "Task list for 005-manvfat-auth-scraper"
---

# Tasks: Authenticated MAN v FAT Fixture Scraping

**Input**: Design documents from `/specs/005-manvfat-auth-scraper/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests — scoped deliberately**: Test-First applies (constitution II), but the **live login
handshake cannot be meaningfully unit-tested** — faking the HTTP request only re-asserts the
constants we wrote and would NOT catch the real failure mode (the site changing its auth/markup).
Per constitution "What NOT to Test" (axios/tough-cookie/cheerio library behaviour), we therefore:

- **DO** unit-test the **pure logic** with real branching, no HTTP: `isAuthenticated()` (incl. the
  off-season authenticated-but-empty case), `Set-Cookie` → jar parsing, `crypto` encrypt/decrypt
  round-trip + bad-key failure, and the recovery-loop control flow via **injected fetch/login seams**.
- **DO NOT** write a mocked-axios "login sends the right fields" test (low value).
- **Validate the live login end-to-end via `quickstart.md`** (T020) — the only thing that proves
  the wire format and persistence are correct.

**Organization**: grouped by user story. All auth logic lives **below** the `IFixtureScraper`
boundary (FR-006, FR-008). Credentials/session are per-team columns — no `leagues` remodel.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1, US2, US3 — maps to spec.md user stories

## Path Conventions

Single project: `src/`, `tests/` at repo root.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 [P] Add `tough-cookie` (+ `@types/tough-cookie`) to `package.json` dependencies; `npm install`.
- [X] T002 [P] Add `MANVFAT_USERNAME`, `MANVFAT_PASSWORD`, and `MANVFAT_CREDENTIAL_KEY` (with a note on generating a 32-byte base64 key, e.g. `openssl rand -base64 32`) to `.env.example` under a new "MAN v FAT Credentials" section.
- [X] T003 [P] Anonymous (logged-out) Watford club-page HTML fixture — **already captured** at `tests/fixtures/html/manvfat-fixtures-unauthenticated.html` (its `<body>` class has NO `logged-in` token; counterpart to the existing authed `tests/fixtures/html/manvfat-fixtures.html`, whose body class DOES). Verify it backs the auth-state detection test (T014); no re-capture needed unless the file is missing.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 Add `manvfat_username`, `manvfat_password`, `manvfat_cookie` (all `text`, nullable) to the `teams` table in `src/database/schema.ts`; update the `Team`/`NewTeam` inferred types' consumers and `src/types/entities.ts` as needed.
- [X] T005 Generate + apply the Drizzle migration for the three new columns (`npm run db:generate` then `db:migrate`); commit the generated SQL under `drizzle/`.
- [X] T006 [P] Add `AuthError` to `src/utils/errors.ts` (extends `AppError`, code `AUTH_ERROR`, exit code `5` — the next free value; existing codes are 1=NotFound, 2=ConfigError, 3=DatabaseError, 4=ScrapingError/WhatsAppError, so 4 is already shared and not a free choice). Actionable message. FR-009's scrape-time missing-credentials case maps to `ConfigError` (exit 2), not `AuthError`.
- [X] T007 [P] Create `src/utils/crypto.ts`: `encryptSecret`/`decryptSecret` (AES-256-GCM, 12-byte random IV, format `base64(iv).base64(tag).base64(ct)`), key read from `MANVFAT_CREDENTIAL_KEY` (base64 → 32 bytes). Throw `ConfigError` on missing/!32-byte key (FR-009).
- [X] T008 Load + validate `MANVFAT_CREDENTIAL_KEY` in `src/config/env.ts` (and surface `manvfatUsername`/`manvfatPassword` for `init` seeding); add to `EnvironmentConfig` in `src/types/config.ts`.

**Checkpoint**: schema migrated; `AuthError` + crypto + key config ready. Stories can begin.

---

## Phase 3: User Story 1 — Scrape with stored credentials (Priority: P1) 🎯 MVP

**Goal**: Log in via the WordPress form POST into a `tough-cookie` jar, persist the encrypted jar to the team row, attach it on fetch, and reuse a still-valid stored cookie without re-login.

**Independent Test**: With creds seeded and no stored cookie, a scrape logs in once, writes encrypted `teams.manvfat_cookie`, and returns the full authenticated fixture set; an immediate second scrape performs no login (quickstart Scenarios 1–2).

### Tests for User Story 1 ⚠️ (pure logic only — write first, ensure they FAIL)

- [ ] T009 [P] [US1] Unit test `crypto.ts` in `tests/unit/utils/crypto.test.ts`: `encryptSecret`→`decryptSecret` round-trips arbitrary strings; ciphertext differs from plaintext and across calls (random IV); a missing/wrong-length key → `ConfigError`; a tampered ciphertext → throws (GCM auth-tag).
- [ ] T010 [P] [US1] Unit test `Set-Cookie` → jar parsing + persist round-trip in `tests/unit/scrapers/manvfat-session.test.ts`: feeding a captured 302 `Set-Cookie` populates the jar with `wordpress_logged_in_*`; serialize+`encryptSecret` then `decryptSecret`+deserialize yields the same `getCookieStringSync`; a 200/loginform response (no cookie) → `AuthError`; constructing a session from a team row with absent `manvfatUsername`/`manvfatPassword` → `ConfigError` (FR-009 scrape-time missing-credentials clause).

### Implementation for User Story 1

- [ ] T011 [US1] Create `src/scraping/manvfat-session.ts` implementing `IManvfatSession` (contracts/manvfat-session.md): construct from team row (if `manvfatUsername`/`manvfatPassword` are absent on the team row, throw `ConfigError` with an actionable message mapped to the existing config-error exit code — the scrape-time missing-credentials clause of FR-009 — before any login attempt; otherwise decrypt password + cookie blob via `crypto.ts`, build `CookieJar`); `login()` (form POST to `/dash/?wpe-login=true`, no-follow-redirect, `wordpress_test_cookie` header, feed `Set-Cookie` into jar, `persistCookie` the encrypted serialized jar, throw `AuthError` on non-302/missing cookie); `cookieHeader(url)`; `hasCookie(url)`. HTTP call is an injectable seam. Never log secrets.
- [ ] T012 [US1] In `src/scraping/fixture-scraper.ts`, give `DefaultFixtureScraper` a constructor taking a `ManvfatSession`; `fetchHtml` logs in if no cookie, then GETs with `Cookie: session.cookieHeader(url)` via the existing `requestQueue`/`withRetry`. Parser path unchanged.
- [ ] T013 [US1] In `src/services/fixture-service.ts`, build a **team-scoped** `DefaultFixtureScraper` per operation (using the fetched team's creds + a `persistCookie` callback that writes `teams.manvfat_cookie`); keep using an injected scraper as-is when provided (tests). Touches `fetchFixtures`/`syncFixtures`/`detectFixtureChanges`.

**Checkpoint**: First scrape logs in + persists encrypted cookie; subsequent scrapes reuse it. MVP works.

---

## Phase 4: User Story 2 — Transparent session recovery (Priority: P1)

**Goal**: Re-login at most once when a response is **not authenticated** (no `logged-in` body class); fail loudly when still not authenticated after one re-login; and treat an authenticated-but-empty page (off-season) as a valid empty result — no re-login, no error.

**Independent Test**: With an invalidated stored cookie, a scrape detects the logged-out page, re-logs-in once, persists the new jar, returns full fixtures; with bad credentials it raises `AuthError`; an authenticated page with no fixtures returns `[]` without re-login or error (quickstart Scenarios 3–4; SC-007).

### Tests for User Story 2 ⚠️ (pure logic + injected seams — write first, ensure they FAIL)

- [ ] T014 [P] [US2] Unit test `isAuthenticated(html)` in `tests/unit/scrapers/fixture-scraper.test.ts`: authed fixture (`tests/fixtures/html/manvfat-fixtures.html`) → `true`; logged-out fixture (`tests/fixtures/html/manvfat-fixtures-unauthenticated.html`, from T003) → `false`; **and a synthetic authenticated-but-empty snippet** (inline HTML `<body class="… logged-in …">` with zero `group-header white`) → `true` (proves off-season ≠ logged out, FR-005a). **Highest-value test** — this is the discrimination that broke and the off-season guard.
- [ ] T015 [P] [US2] Unit test the recovery-loop control flow in `tests/unit/scrapers/fixture-scraper.test.ts` using **injected fake fetch + fake login seams** (no axios): (a) first fetch not-authenticated → login → second fetch authenticated ⇒ returns HTML, login called exactly once; (b) both fetches not-authenticated ⇒ throws `AuthError` (FR-004/FR-005); (c) **first fetch already authenticated but empty ⇒ returns it directly, login NOT called, no error** (FR-005a / SC-007).

### Implementation for User Story 2

- [ ] T016 [P] [US2] Add exported pure helper `isAuthenticated(html: string): boolean` to `src/scraping/fixture-scraper.ts` using cheerio `$('body').hasClass('logged-in')` (research.md Finding 5) — independent of fixture presence.
- [ ] T017 [US2] Extend `DefaultFixtureScraper.fetchHtml` (from T012) with the recovery loop: fetch → if `!isAuthenticated`, `session.login()` once (persists jar) → re-fetch → if still `!isAuthenticated`, throw `AuthError`. Enforce at-most-once (FR-004); an authenticated response is returned as-is even with zero fixtures (FR-005a). Expose the fetch/login seams T015 injects.

**Checkpoint**: Expired cookies self-heal; bad creds fail loudly. US1 + US2 both work.

---

## Phase 5: User Story 3 — Safe credential & session handling (Priority: P2)

**Goal**: Password + cookie encrypted at rest; key only in env; secrets never logged. Credentials seeded onto the team at `init`.

**Independent Test**: After a scrape, `teams.manvfat_password`/`manvfat_cookie` are unreadable in the raw DB without the key; debug logs contain no password, cookie, `Cookie` header, or key (quickstart Scenarios 5–6).

### Implementation for User Story 3

- [ ] T018 [US3] In `src/cli/commands/init.ts`, seed `manvfat_username`/`manvfat_password` (encrypted via `crypto.ts`) onto the team from `MANVFAT_USERNAME`/`MANVFAT_PASSWORD`, mirroring how `CLUB_URL` → `teams.clubUrl` is handled (FR-010). Clear error if creds absent at init.
- [ ] T019 [P] [US3] Audit `manvfat-session.ts`, the `fetchHtml` changes, and `crypto.ts` so `pwd`, decrypted password, `cookieValue`/jar blob, any `Cookie`/`Set-Cookie` header, and `MANVFAT_CREDENTIAL_KEY` are never passed to `logger.*` (redact to a boolean/"present" marker). Verify against `src/utils/logger.ts`.

**Checkpoint**: Secrets encrypted on disk and absent from logs.

---

## Phase 6: Polish & Live Validation

- [ ] T020 [US1+US2+US3] Run `quickstart.md` Scenarios 1–6 against the **live** site (operator-authorised) — authoritative validation of the login wire format, persistence, recovery, and encryption-at-rest (SC-001…SC-006).
- [ ] T021 [P] Verify existing scraper/fixture tests still pass unchanged (`MockFixtureScraper`, `StubScraper`, `tests/integration/fixtures/*`, `tests/integration/seasons/*`) — confirms `IFixtureScraper` boundary preservation (FR-008).
- [ ] T022 [P] `npm run build` + `npm run format` clean; no `any` introduced (constitution III).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies. T003 gates T014.
- **Foundational (Phase 2)**: depends on Setup — BLOCKS all stories. T004 → T005; T006/T007 [P]; T008 after T007.
- **US1 (Phase 3)**: depends on Foundational (needs schema, crypto, key). Delivers session module + cookie-on-fetch + persistence.
- **US2 (Phase 4)**: depends on **US1** (extends `manvfat-session.ts` + `fetchHtml` from T011/T012) — same files, not parallel with US1.
- **US3 (Phase 5)**: T018 depends on crypto (T007) + schema (T004); T019 audits US1/US2 code.
- **Polish (Phase 6)**: after desired stories. T020 (live) needs US1+US2+US3.

### Within Each User Story

- Pure-logic tests (T009–T010, T014–T015) written and FAILING before their implementation.
- Session module (T011) before scraper wiring (T012) before service wiring (T013) before recovery loop (T017).

### Parallel Opportunities

- **Setup**: T001, T002, T003 all [P].
- **Foundational**: T006 + T007 [P]; T008 after T007; T004→T005 sequential (migration).
- **US1 tests**: T009 + T010 [P].
- **US2**: T014 + T016 [P] (test + helper); T015 after T011's seam exists.

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & VALIDATE** (quickstart 1–2): a credentialed scrape returns full fixtures and reuses the persisted cookie. This alone restores the broken scraper.

### Incremental Delivery

US1 (MVP — fixtures work again) → US2 (self-healing on expiry) → US3 (init seeding + secrets hardening) → Polish (live validation + build). Each story is independently testable.

### Testing posture

Unit suite covers pure logic only (`isAuthenticated` incl. off-season, cookie/jar parse, crypto round-trip,
recovery-loop via seams). The live login + persistence is proven by T020 (`quickstart.md`), not by
faking HTTP.
