# Data Model: Authenticated MAN v FAT Fixture Scraping

This feature adds three nullable columns to the existing `teams` table and one config/env value.
No new tables; no `leagues` remodel. Existing `Game`, `Season`, `Team`, `gatewayCredentials`
entities are otherwise untouched.

## teams table — NEW columns

| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `manvfat_username` | `text` (nullable) | no | Player login email. Not secret. |
| `manvfat_password` | `text` (nullable) | **yes** (AES-256-GCM) | Player password. Stored as `base64(iv).base64(tag).base64(ct)`. |
| `manvfat_cookie` | `text` (nullable) | **yes** (AES-256-GCM) | Serialized `tough-cookie` jar blob (`jar.serializeSync()` JSON), encrypted. Holds the `wordpress_logged_in_*` cookie incl. its own expiry/path. Null until first login. |

- **No separate cookie name/value or expiry columns** — the serialized jar carries all of that
  (research.md persistence decision). Re-login is reactive (gated-response), so no stored expiry
  is read.
- Migration: a single Drizzle migration adding three nullable columns (`drizzle-kit generate` +
  `migrate`). No backfill required (existing single team gets columns seeded at next `init`/run).

## Configuration / environment

| Value | Source | Required | Notes |
|-------|--------|----------|-------|
| `MANVFAT_USERNAME` | `.env` | for `init` (FR-010) | Seeds `teams.manvfat_username`. |
| `MANVFAT_PASSWORD` | `.env` | for `init` (FR-010) | Encrypted, seeds `teams.manvfat_password`. |
| `MANVFAT_CREDENTIAL_KEY` | `.env` | for any scrape (FR-009) | 32-byte AES key, base64-encoded. Missing/wrong-length → `ConfigError`. |

Credentials are **seeded onto the team at `init`** (mirroring how `CLUB_URL` → `teams.clubUrl`
works today). The scraper reads them off the team row, not from the env, at scrape time.

## ManvfatSession (runtime, not persisted as such)

In-memory helper bridging the team row and the live HTTP layer:

| Field | Type | Notes |
|-------|------|-------|
| `username` | `string` | from `teams.manvfat_username` |
| `password` | `string` | decrypted from `teams.manvfat_password` |
| `jar` | `tough-cookie` `CookieJar` | deserialized from decrypted `teams.manvfat_cookie`, or empty |

Operations: `cookieHeader(url)` (`jar.getCookieStringSync`), `login()` (form POST → feed
`Set-Cookie` into jar), `persist()` (encrypt `jar.serializeSync()` → write `teams.manvfat_cookie`).

## State transitions

```
            ┌─────────────┐  no cookie / fetch returns NOT-authenticated (no logged-in body class)
            │  NO COOKIE  │ ───────────────┐
            └─────────────┘                │
                  ▲                         ▼
   re-login (≤1   │                   ┌───────────┐  login 302 + Set-Cookie → jar → encrypt → teams.manvfat_cookie
   per fetch when │                   │  LOGGING  │ ──────────────────────────────────────────► VALID
   not auth'd)    │                   │    IN     │
                  │                   └───────────┘  non-302 / loginform re-rendered
                  │                         │                │
            ┌─────────────┐                 │                ▼
            │   VALID     │ ◄───────────────┘          ┌───────────┐
            │ jar sent on │  fetch returns AUTHENTICATED │ AUTH FAIL │ ─ still not auth'd after relogin ─► AuthError
            │   fetch     │  (logged-in body class)      └───────────┘   (FR-005; NOT thrown for empty fixtures)
            └─────────────┘
                  │ fetch returns NOT-authenticated (Finding 5)
                  └────────────────────────────────────► back to NO COOKIE (re-login once)

   NOTE: an AUTHENTICATED page with zero fixtures (off-season) stays in VALID and returns an
   empty list — it does NOT transition to LOGGING IN or AUTH FAIL (FR-005a).
```

## Authentication signal (derived, not stored)

`isAuthenticated(html)` → `true` when the `<body>` tag carries the WordPress `logged-in` CSS class
(`$('body').hasClass('logged-in')` — research.md Finding 5). This is the re-login trigger
(`!isAuthenticated` → re-login, FR-004), and is **independent of fixture content** so the
off-season empty case (FR-005a) is not mistaken for being logged out.

## Encryption (src/utils/crypto.ts)

`encryptSecret(plaintext: string): string` / `decryptSecret(ciphertext: string): string`,
AES-256-GCM, 12-byte random IV, key from `MANVFAT_CREDENTIAL_KEY` (base64 → 32 bytes). Stored
format `base64(iv).base64(tag).base64(ciphertext)`. A missing/!32-byte key throws `ConfigError`
(FR-009); a failed GCM auth-tag check on decrypt throws (tamper/corruption or wrong key).

## AuthError (error type)

New error in `src/utils/errors.ts`, distinct from network/HTTP errors, raised when login fails or
a fetch is still **not authenticated** (no `logged-in` body class) after one re-login. Carries an
actionable message and a distinct exit code. It is **not** raised merely because an authenticated
page has zero fixtures (FR-005a) — that is a valid empty result.
