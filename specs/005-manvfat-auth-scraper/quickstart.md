# Quickstart: Validate Authenticated Fixture Scraping

Live validation of the auth scraper against the real MAN v FAT site (operator-authorised, own
account + own club).

## Prerequisites

- A valid MAN v FAT player account.
- A 32-byte encryption key: `openssl rand -base64 32`.
- `.env` configured with:
  ```
  CLUB_URL=https://manvfatfootball.com/club/<your-club>/
  MANVFAT_USERNAME=<player email>
  MANVFAT_PASSWORD=<player password>
  MANVFAT_CREDENTIAL_KEY=<base64 32-byte key from openssl above>
  ```
- Build: `npm run build`. Migrate: `npm run db:migrate`.

## Scenario 1 — init seeds credentials, first scrape logs in (SC-001)

```bash
captain-stats init                   # seeds manvfat_username/password (encrypted) onto the team
captain-stats fixtures --all
```

**Expect**: a login occurs once, the full fixture list is returned (many weeks — parity with the
authenticated page, not an empty list), and `teams.manvfat_cookie` is now populated.

## Scenario 2 — Second scrape reuses the cookie, no login (SC-002)

```bash
LOG_LEVEL=debug captain-stats fixtures --all
```

**Expect**: full fixtures again, and **no** login request in the logs (the stored cookie was
reused).

## Scenario 3 — Invalidated cookie re-authenticates once (SC-003)

```bash
# Blank the stored cookie to simulate expiry/rejection
sqlite3 "$DATABASE_PATH" "UPDATE teams SET manvfat_cookie = NULL;"
captain-stats fixtures --all
```

**Expect**: the fetched page lacks the `logged-in` body class, so the tool logs in once,
repopulates `teams.manvfat_cookie`, and returns full fixtures.

> **Off-season note (SC-007 / FR-005a)**: re-login is keyed off the WordPress `logged-in` body
> class, **not** the presence of fixtures. An authenticated page with zero fixtures (end of
> season / between seasons) returns an empty list **without** re-logging-in or raising an error.
> If you can observe this during the off-season, confirm a scrape returns `[]` cleanly (exit 0,
> no `AuthError`, no extra login in debug logs).

## Scenario 4 — Bad credentials fail loudly, store nothing (SC-004)

```bash
sqlite3 "$DATABASE_PATH" "UPDATE teams SET manvfat_cookie = NULL;"
# temporarily set a wrong password and re-seed, or edit the row, then:
captain-stats fixtures --all; echo "exit=$?"
```

**Expect**: a clear `AuthError` (not a generic network error), non-zero exit, and **no** fixtures
persisted.

## Scenario 5 — Secrets encrypted at rest (SC-006)

```bash
sqlite3 "$DATABASE_PATH" "SELECT manvfat_password, manvfat_cookie FROM teams;"
```

**Expect**: opaque `base64(iv).base64(tag).base64(ct)` blobs — not the plaintext password, not a
readable `wordpress_logged_in_*` cookie.

## Scenario 6 — Secrets stay out of logs (SC-006)

```bash
LOG_LEVEL=debug captain-stats fixtures --all 2>&1 \
  | grep -iE "$MANVFAT_PASSWORD|wordpress_logged_in|Cookie:|$MANVFAT_CREDENTIAL_KEY" \
  && echo "LEAK" || echo "clean"
```

**Expect**: `clean` — no password, cookie, Cookie header, or key in output.
