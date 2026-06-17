# Research: MAN v FAT Authentication

All findings below were **verified live** against `manvfatfootball.com` on 2026-06-16 using the
operator's real player account (read-only verification — login + GET of the club page only).

## Decision: Plain HTTP WordPress form login + persisted cookie jar (no headless browser)

### Finding 1 — The site is WordPress on WP Engine; login is a standard `wp-login` form

The "player portal" link (`/portal/`) redirects unauthenticated users to
`/dash/?redirect_to=...`, which renders the standard WordPress login form:

```
<form name="loginform" id="loginform"
      action="https://manvfatfootball.com/dash/?wpe-login=true" method="post">
  <input type="text"     name="log"  ...>   <!-- username/email -->
  <input type="password" name="pwd"  ...>   <!-- password -->
  <input name="rememberme" type="checkbox" value="forever">
  <input type="submit"  name="wp-submit" value="Log In">
  <input type="hidden"  name="redirect_to" value="...">
  <input type="hidden"  name="testcookie" value="1">
</form>
```

`wpe-login=true` is the WP Engine login marker. The login is a pure HTML form POST — **no JS,
no headless browser, no API token, no CSRF nonce** on the login itself (`testcookie` is the
only anti-bot gate; see Finding 2).

### Finding 2 — The working handshake

Verified sequence (curl, to be reproduced with axios):

1. **POST** `https://manvfatfootball.com/dash/?wpe-login=true` with:
   - body (form-urlencoded): `log=<username>`, `pwd=<password>`, `wp-submit=Log In`,
     `redirect_to=https://manvfatfootball.com/club/<club>/`, `testcookie=1`, `rememberme=forever`
   - **request header**: `Cookie: wordpress_test_cookie=WP Cookie check`
     — WordPress requires this test cookie to be present on the POST or login is rejected.
     It does **not** need to come from a prior Set-Cookie; sending it directly works.
   - a normal browser `User-Agent`.
2. **Response**: `HTTP 302` → `Location: <redirect_to>` with `Set-Cookie:` for:
   - `wordpress_logged_in_<hash>` — **path `/`** — *this is the one that matters for scraping*
   - `wordpress_sec_<hash>` — paths `/wp-admin` and `/wp-content/plugins` (admin-only; not needed)
   - cookie `Max-Age` ≈ **1,252,800s (~14.5 days)** with `rememberme=forever`; `Secure; HttpOnly`.

A non-302 response (200 that re-renders `loginform`) means failed login → treat as auth error.

### Finding 3 — Only `wordpress_logged_in_*` (path `/`) is needed to read fixtures

Re-fetching `https://manvfatfootball.com/club/<club>/` with just the path-`/` cookie returns the
full authenticated page. Verified parity on the Watford page:

| Signal (grep count)        | Anonymous | Authenticated |
|----------------------------|-----------|---------------|
| `group-header white` (weeks) | 0       | 14            |
| `team-name` cells          | 2         | 68            |
| `fixture-table`            | 21 (CSS only) | 65        |
| `no-highlight` rows        | 32        | 321           |

### Finding 4 — Parser selectors are unchanged

The authenticated HTML uses the **same** structure the current parser already targets
(`scrapeFixtures()`: `.group-header.white`, `table.fixture-table`, `tr.no-highlight`,
`td.team-name`, `td.game-week-no`, `td.score`). No parser changes required — confirmed by the
matching selector counts above. **The fix is entirely in the fetch layer.**

### Finding 5 — Authentication-state signal (NOT "are there fixtures")

**Verified live.** The robust authentication marker is the WordPress **`logged-in` CSS class on
the `<body>` tag**, present on *every* page for an authenticated user regardless of content:

| Signal | Anonymous | Authenticated |
|--------|-----------|---------------|
| `logged-in` token in `<body class="…">` | **absent** | **present** |
| "Log Out" / "Logout" link | 0 | 4 |
| "Player Portal" CTA | 5 | 1 |
| `wp-admin` references | 0 | 22 |

The check is therefore `$('body').hasClass('logged-in')` (cheerio — robust to class ordering /
whitespace), **not** the presence of fixtures.

**Why this matters (the off-season trap)**: keying re-login off "0 week headers" conflates two
distinct states — *logged out* vs *logged in but genuinely no fixtures* (end of season / between
seasons). The latter is a **valid empty result**. Using fixture-count as the auth signal would, in
the off-season, trigger a needless re-login and then throw a false `AuthError` on a page that is in
fact correctly authenticated and simply empty. The `logged-in` body class is independent of fixture
content, so:

- **logged out** (no `logged-in` class) → re-login (FR-004).
- **logged in, fixtures present** → parse normally.
- **logged in, no fixtures** (off-season) → **valid empty result**; do NOT re-login, do NOT error.

The "Log Out" link is an equivalent corroborating signal; the body class is primary.

## Decision: Cookie persistence — serialized jar, encrypted, on the team row

**Chosen**: Use a `tough-cookie` `CookieJar`. After login, feed the `Set-Cookie` header(s) into the
jar, serialize it (`jar.serializeSync()` → JSON), **AES-256-GCM-encrypt** the blob, and store it in
a single new column `teams.manvfat_cookie`. On each fetch, decrypt + `CookieJar.deserializeSync()`,
then `jar.getCookieStringSync(clubUrl)` builds the `Cookie` request header.

- **Single column, no name/value split, no expiry column.** The jar carries name/value/path/expiry
  internally; re-login is triggered **reactively** by the gated-response check (Finding 5), so we
  never need to read or compare an expiry ourselves. This is the simplification the operator
  identified — one opaque blob, mirroring `gatewayCredentials.snapshot`.
- **Per team.** Credentials + cookie live on the `teams` row (no `leagues`/sessions table). The
  ~14-day session lifetime means almost every run reuses the stored cookie — roughly one login per
  fortnight, not per run (SC-002).
- **Rationale**: a jar handles WP setting additional cookies in future for free, and serialization
  to one encrypted blob keeps the schema change to a single nullable column.
- **Alternative — store the raw `Cookie` header string manually**: rejected; brittle if WP adds
  cookies, and a jar is barely more code.

## Decision: HTTP client / dependencies

**Chosen**: Keep `axios`; add **`tough-cookie`** (pure-JS, lightweight) as the jar. Build the
`Cookie` request header from the jar manually (`getCookieStringSync`) and feed login `Set-Cookie`
responses back into the jar (`setCookieSync`) — **no** `axios-cookiejar-support` interceptor needed,
keeping axios usage explicit and the dependency surface minimal. No headless browser (SC-005).

- **Alternative — `axios-cookiejar-support`**: deferred; not needed for a single GET + single login
  POST, and avoids another dependency.

## Decision: Encryption of secrets at rest

**Chosen**: AES-256-GCM via Node's built-in `crypto`. A small `src/utils/crypto.ts` exposes
`encryptSecret(plaintext)` / `decryptSecret(ciphertext)`. The 32-byte key is read from
`MANVFAT_CREDENTIAL_KEY` (base64-encoded in `.env`). Stored format: `base64(iv).base64(tag).base64(ct)`
with a random 12-byte IV per encryption. `manvfat_password` and the `manvfat_cookie` jar blob are
encrypted; `manvfat_username` is plaintext (not secret).

- **Rationale**: GCM gives authenticated encryption (tamper-evident) with zero new dependencies.
  A missing/!32-byte key fails fast with a config error (FR-009). Encrypting the cookie too (not
  just the password) is consistent — the cookie *is* bearer access.
- **Alternative — plaintext (matching `gatewayCredentials`)**: rejected by operator decision; the
  reusable password warrants encryption. (The pre-existing plaintext WhatsApp snapshot is left
  as-is — out of scope here.)
- **Note**: the encryption key in `.env` and the encrypted DB sit on the same host, so this
  protects against casual DB exfiltration / accidental commit of the `.db`, not a full host
  compromise. That is the accepted threat model for this single-operator tool.

## Decision: Politeness / safety

- Reuse the existing `p-queue` rate limiter and `withRetry`; login is infrequent (≈fortnightly).
- Never log `pwd`, the `Cookie`/`Set-Cookie` headers, the jar blob, or the encryption key.
- `rememberme=forever` maximises session life and minimises login frequency. The operator
  explicitly authorised use of their account for their own club's data.
