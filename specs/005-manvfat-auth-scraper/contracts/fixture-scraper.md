# Contract: IFixtureScraper (unchanged boundary) + fetchHtml auth behaviour

## IFixtureScraper — UNCHANGED

The service boundary consumed by `FixtureService` and mocked by tests is **preserved verbatim**:

```ts
export interface IFixtureScraper {
  fetchHtml(url: string): Promise<string>;
  parseFixtures(html: string): Fixture[];
}
```

Consumers (`FixtureService.fetchFixtures/syncFixtures/detectFixtureChanges`, `init`) and mocks
(`MockFixtureScraper`, `ErrorMockScraper`, `StubScraper`) require **no change** (FR-008).
`parseFixtures`/`scrapeFixtures` logic is **unchanged** (FR-006) — the authenticated HTML matches
the existing selectors (research.md Finding 4).

## Wiring — team auth context (below the boundary)

`DefaultFixtureScraper` gains a constructor accepting a `ManvfatSession` (or its deps). Because
`fetchHtml(url)` carries no team, **`FixtureService` builds a team-scoped `DefaultFixtureScraper`
per operation** (it already calls `getTeam(teamId)` first, and the team row now carries
credentials + cookie + provides the `persistCookie` callback). When a scraper is **injected**
(tests), `FixtureService` uses it as-is and none of the auth path runs.

## DefaultFixtureScraper.fetchHtml — NEW auth behaviour

```
fetchHtml(url):
  if not session.hasCookie(url): session.login()       # no stored cookie → log in first
  html = GET url with Cookie: session.cookieHeader(url)  # via existing withRetry + p-queue
  if not isAuthenticated(html):                        # Finding 5: no `logged-in` body class
      session.login()                                  # at-most-once re-login (FR-004); persists jar
      html = GET url with Cookie: session.cookieHeader(url)
      if not isAuthenticated(html):
          throw AuthError(...)                         # FR-005 — cannot authenticate
  return html                                          # may be authenticated-but-empty (off-season) — VALID (FR-005a)
```

- The re-login trigger is **authentication state** (`logged-in` body class), NOT fixture
  presence. An authenticated page with zero fixtures returns normally and `parseFixtures` yields
  `[]` — no re-login, no error (FR-005a).
- **At-most-once** re-login per `fetchHtml` call (FR-004).
- Rate limiting/retry via the existing `requestQueue`/`withRetry` (unchanged cadence).
- `session.login()` persists the refreshed encrypted jar to `teams.manvfat_cookie` (FR-003).
- Credentials, cookies, and the encryption key are never logged (FR-007).

## New helper contract

```ts
/** True when the page is authenticated — the WordPress `logged-in` class is on <body>
 *  (`$('body').hasClass('logged-in')`). Independent of whether fixtures are present (Finding 5). */
export function isAuthenticated(html: string): boolean;
```
