# Contract: ManvfatSession helper

New module `src/scraping/manvfat-session.ts`. Encapsulates login + jar-based cookie persistence to
the team row. Lives *below* the `IFixtureScraper` boundary, so it is invisible to `FixtureService`
consumers and test mocks.

## Interface (indicative)

```ts
import { CookieJar } from 'tough-cookie';

export interface ManvfatSessionDeps {
  team: { id: number; clubUrl: string; manvfatUsername: string; manvfatPassword: string;
          manvfatCookie: string | null };
  /** Persist the (encrypted) serialized jar back onto teams.manvfat_cookie. */
  persistCookie: (teamId: number, encryptedJarBlob: string) => Promise<void>;
}

export interface IManvfatSession {
  /** Cookie header for an authenticated GET (empty string if jar has nothing for the URL). */
  cookieHeader(url: string): string;
  /** Perform the WordPress form-POST login, populate the jar, and persist it. */
  login(): Promise<void>;
}
```

> **Note (T017a):** an earlier `hasCookie(url)` gate was dropped. Once the recovery loop landed,
> response-driven `isAuthenticated` became the single authority for "is this session valid", so a
> cookie-presence check was at best an optimization and at worst misleading (a cookie string
> existing is NOT proof of an authenticated session — research.md Finding 5). `fetchHtml` now
> always fetches and lets the response decide.

## Behavioural contract

1. **Construction**: decrypt `team.manvfatPassword` and `team.manvfatCookie` (if present) via
   `src/utils/crypto.ts`; deserialize the cookie blob into a `tough-cookie` `CookieJar` (empty jar
   if null).
2. **`login()`** issues `POST https://manvfatfootball.com/dash/?wpe-login=true` with form body
   `log`, `pwd`, `wp-submit=Log In`, `redirect_to=<clubUrl>`, `testcookie=1`, `rememberme=forever`,
   plus request header `Cookie: wordpress_test_cookie=WP Cookie check`, following **no** redirect.
   - On `302` with a `wordpress_logged_in_*` Set-Cookie → `jar.setCookieSync(...)` for each
     Set-Cookie, then `persistCookie(team.id, encryptSecret(jar.serializeSync()))`.
   - On `200` (login form re-rendered) or missing `wordpress_logged_in_*` → throw `AuthError`.
3. **`cookieHeader(url)`** = `jar.getCookieStringSync(url)`.
4. **Rate limiting**: the default `login()` HTTP call routes its POST through the shared per-host
   limiter (`src/scraping/request-queue.ts`, `enqueueRequest`) — the same queue the page GET uses —
   so logins are throttled by design, not incidentally by their call-site (research.md "Politeness").
   The injected test seam bypasses it (no network).
5. **Secrecy**: `pwd`, decrypted password, `cookieHeader`, `Set-Cookie`, the jar blob, and the
   encryption key are never passed to the logger.

## Test contract (Vitest)

- `Set-Cookie` → jar parsing is unit-tested against captured header fixtures (302 success populates
  the jar with `wordpress_logged_in_*`; 200 / missing cookie → `AuthError`).
- Encrypt → persist → reconstruct round-trip: a jar serialized + `encryptSecret` then
  `decryptSecret` + deserialized yields the same cookie string. (Uses `crypto.ts`, no network.)
- `login()`'s HTTP call is an **injectable seam** so the recovery-loop test (see
  `fixture-scraper.md`) can drive it without faking axios; the live `login()` is exercised only via
  `quickstart.md`.
