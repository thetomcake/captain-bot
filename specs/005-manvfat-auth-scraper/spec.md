# Feature Specification: Authenticated MAN v FAT Fixture Scraping

**Branch**: `005-manvfat-auth-scraper` | **Date**: 2026-06-16

## Problem

The MAN v FAT club fixture pages (e.g. `https://manvfatfootball.com/club/watford/`) used to
serve full fixture data to anonymous visitors. The site has since been changed so that fixture
data is only rendered for **logged-in players**. The existing scraper
(`src/scraping/fixture-scraper.ts`) issues an unauthenticated `axios.get`, so it now receives a
page with the fixture tables present in markup but effectively **empty of fixtures** — confirmed
empirically: an anonymous fetch yields **0** week headers / **2** team cells, while an
authenticated fetch of the same URL yields **14** week headers / **68** team cells / **321**
fixture rows.

The login is a standard WordPress (WP Engine) form login reached via the "player portal" link.
The user has a valid player account. We need the scraper to authenticate, **persist the session**
(per team, in the database) so it is not re-established on every run, and transparently recover
when the session expires.

## Scope decisions (agreed)

- ManVFat credentials and the session cookie are stored **per team, on the `teams` table** — no
  separate sessions table, no `leagues`/multi-tenant remodel. Kept deliberately simple for now.
- The session cookie is persisted as a **single serialized cookie-jar blob** (`manvfat_cookie`),
  not split into name/value, and without a separate expiry column (re-login is triggered
  reactively by gated-response detection).
- Secrets at rest are **encrypted** (AES-256-GCM) with a key from `MANVFAT_CREDENTIAL_KEY`: the
  `manvfat_password` and the `manvfat_cookie` blob are encrypted; the username is plaintext.

## User Scenarios

### US1 — Scrape fixtures with stored credentials (Priority: P1)

As the operator, when I run any command that scrapes fixtures (`fixtures`, `sync`, `init`,
`daemon`), the tool logs in to MAN v FAT using the team's stored credentials and returns the full
fixture list, exactly as it did before the site required login.

**Acceptance**:
1. **Given** a team with valid `manvfatUsername`/`manvfatPassword` and no stored cookie, **when** a
   scrape runs, **then** the tool logs in, persists the encrypted cookie jar to the team row, and
   the parsed fixture count matches the authenticated page (not the empty anonymous page).
2. **Given** a team with a previously persisted, still-valid cookie, **when** a scrape runs,
   **then** the tool reuses the stored cookie **without** performing a new login.

### US2 — Transparent session recovery (Priority: P1)

As the operator, I never have to manually re-authenticate. When the stored session has expired or
is rejected, the tool detects the gated/empty response, logs in again once, persists the new
cookie jar, and retries the scrape within the same run.

**Acceptance**:
1. **Given** an expired/invalid stored cookie, **when** a scrape runs, **then** the tool detects
   the unauthenticated response, re-logs-in exactly once, persists the new jar, and returns full
   fixtures.
2. **Given** re-login also fails (bad credentials / site change), **when** a scrape runs, **then**
   the tool fails with a clear, actionable error and does **not** silently persist empty fixtures.

### US3 — Safe credential & session handling (Priority: P2)

As the operator, my password and session cookie are encrypted at rest in the database, the
encryption key lives only in the environment (never committed), and secrets never appear in logs.

## Functional Requirements

- **FR-001**: The scraper MUST authenticate to MAN v FAT before fetching gated club pages, using
  the credentials stored on the team being scraped.
- **FR-002**: Login MUST be performed as an HTTP form POST to the WordPress login endpoint
  (`/dash/?wpe-login=true`) — no headless browser — establishing the WordPress
  `wordpress_logged_in_*` session cookie. (See `research.md` for the exact handshake.)
- **FR-003**: The session MUST be persisted as an encrypted, serialized cookie-jar blob on the
  team's row (`teams.manvfat_cookie`) and reused across runs without re-login.
- **FR-004**: The scraper MUST determine authentication state from an explicit **auth marker** —
  the WordPress `logged-in` class on the `<body>` tag (`research.md` Finding 5) — NOT from whether
  fixtures are present. On an unauthenticated response, it MUST re-login **at most once** and retry
  within the same run, persisting the refreshed jar.
- **FR-005**: On repeated authentication failure (still no `logged-in` marker after one re-login),
  the scraper MUST raise a distinct, actionable error (separate from generic network/HTTP errors)
  and MUST NOT treat the page as a successful scrape.
- **FR-005a**: An **authenticated** response that contains **no fixtures** (e.g. end-of-season /
  between-seasons) MUST be treated as a **valid empty result** — the scraper MUST NOT re-login and
  MUST NOT raise an auth error in this case. (This is the off-season case the auth-marker approach
  exists to disambiguate.)
- **FR-006**: Fixture **parsing** behaviour MUST be unchanged — the authenticated HTML uses the
  same selectors the current parser already targets (`group-header white`, `fixture-table`,
  `team-name`, `no-highlight`). This feature changes only the fetch/auth layer.
- **FR-007**: `manvfat_password` and `manvfat_cookie` MUST be encrypted at rest with AES-256-GCM
  using a 32-byte key sourced from `MANVFAT_CREDENTIAL_KEY`. The key MUST NOT be committed, and
  credentials/cookies/keys MUST NOT be logged.
- **FR-008**: The `IFixtureScraper` service boundary consumed by `FixtureService` MUST be preserved
  so existing consumers and test mocks are unaffected.
- **FR-009**: A missing/invalid `MANVFAT_CREDENTIAL_KEY` (absent, or not 32 bytes) MUST produce a
  clear configuration error; missing credentials on a team being scraped MUST likewise produce a
  clear, actionable error (mapped to the existing config-error exit code).
- **FR-010**: Credentials MUST be seedable onto the team from the environment
  (`MANVFAT_USERNAME`/`MANVFAT_PASSWORD`) at `init`, consistent with how `CLUB_URL` is seeded today.

## Success Criteria

- **SC-001**: After configuring credentials, `captain-stats fixtures`/`sync` returns the full
  authenticated fixture set (parity with pre-login-wall behaviour) on a live run.
- **SC-002**: A second consecutive scrape performs **no** login request (cookie reuse verifiable
  via logs/instrumentation).
- **SC-003**: With a deliberately invalidated stored cookie, a scrape still succeeds by
  re-authenticating exactly once.
- **SC-004**: With invalid credentials, a scrape fails with the dedicated auth error and stores no
  fixtures.
- **SC-005**: No new heavyweight **runtime** dependency (e.g. a headless browser) is introduced;
  `tough-cookie` (lightweight, pure-JS) is the only new runtime dependency. Dev-only type
  packages (`@types/tough-cookie`) are exempt — they ship no runtime code.
- **SC-006**: `manvfat_password`/`manvfat_cookie` are unreadable in the raw DB without the key;
  credentials, cookies, and the key never appear in committed files or log output.
- **SC-007**: An authenticated page with zero fixtures returns an empty fixture list **without**
  re-logging-in and **without** raising an auth error (off-season robustness, FR-005a).

## Out of Scope

- Scraping any data beyond the club fixture page already supported.
- `leagues`/multi-league remodelling and multi-team-per-league fixture sharing (explicitly
  deferred — credentials live per team for now).
- Key rotation tooling and DB-level encryption beyond the two encrypted columns.
