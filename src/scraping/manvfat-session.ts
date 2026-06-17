/**
 * MAN v FAT player-portal session (feature 005).
 *
 * Encapsulates the WordPress form-POST login and a `tough-cookie` jar that is encrypted
 * and persisted onto the team row (`teams.manvfat_cookie`). Lives *below* the
 * `IFixtureScraper` boundary, so `FixtureService` consumers and test mocks never see it.
 *
 * The fixtures page is gated behind a WordPress login; the verified handshake (research.md
 * Finding 2) is a plain form POST to `/dash/?wpe-login=true` with a `wordpress_test_cookie`
 * request cookie, returning a `302` and a `wordpress_logged_in_*` Set-Cookie. The login HTTP
 * call is an **injectable seam** (`loginRequest`) so the recovery-loop and parsing logic can
 * be unit-tested without faking axios; the live handshake is validated via `quickstart.md`.
 *
 * Secrets discipline (FR-007): the decrypted password, the cookie header / jar blob, and the
 * encryption key are never passed to the logger from this module.
 */

import axios from 'axios';
import { CookieJar } from 'tough-cookie';

import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { AuthError, ConfigError } from '../utils/errors.js';
import { enqueueRequest } from './request-queue.js';

/** WordPress / WP Engine login endpoint (research.md Finding 1). */
export const MANVFAT_LOGIN_URL = 'https://manvfatfootball.com/dash/?wpe-login=true';

/**
 * WordPress requires this test cookie to be present on the login POST or it rejects the
 * attempt. It does not need to originate from a prior Set-Cookie — sending it directly
 * works (research.md Finding 2).
 */
const WP_TEST_COOKIE_HEADER = 'wordpress_test_cookie=WP Cookie check';

/** Browser-shaped UA, consistent with the unauthenticated scraper path. */
const USER_AGENT = 'Mozilla/5.0 (compatible; CaptainStats/1.0)';

/** The login-cookie prefix that proves an authenticated session (research.md Finding 2/3). */
const LOGGED_IN_COOKIE_PREFIX = 'wordpress_logged_in_';

/** The subset of a team row the session needs. */
export interface ManvfatSessionTeam {
  id: number;
  clubUrl: string;
  manvfatUsername: string | null;
  manvfatPassword: string | null;
  manvfatCookie: string | null;
}

/** Result of the login HTTP call (the part the session cares about). */
export interface LoginResponse {
  status: number;
  /** Raw `Set-Cookie` header values from the response. */
  setCookie: string[];
}

/**
 * Injectable login-HTTP seam. The default issues the real axios POST; tests substitute a
 * fake so the jar/auth logic can be exercised without a network call.
 */
export type LoginRequestFn = (params: {
  url: string;
  body: string;
  cookieHeader: string;
}) => Promise<LoginResponse>;

export interface ManvfatSessionDeps {
  team: ManvfatSessionTeam;
  /** 32-byte AES key (from `getCredentialKey`). */
  key: Buffer;
  /** Persist the (encrypted) serialized jar back onto `teams.manvfat_cookie`. */
  persistCookie: (teamId: number, encryptedJarBlob: string) => Promise<void>;
  /** Override the login HTTP call (defaults to a real axios POST). */
  loginRequest?: LoginRequestFn;
}

export interface IManvfatSession {
  /** Cookie header for an authenticated GET (empty string if the jar has nothing for the URL). */
  cookieHeader(url: string): string;
  /** Perform the WordPress form-POST login, populate the jar, and persist it. */
  login(): Promise<void>;
  /** Whether a usable cookie currently exists in the jar (cheap gate before fetching). */
  hasCookie(url: string): boolean;
}

/**
 * Default login HTTP call: a no-follow-redirect form POST via axios. The request passes through
 * the shared per-host rate limiter (`request-queue.ts`) so logins are throttled by design, not
 * incidentally by their call-site.
 */
async function defaultLoginRequest(params: {
  url: string;
  body: string;
  cookieHeader: string;
}): Promise<LoginResponse> {
  return enqueueRequest(async () => {
    const response = await axios.post<unknown>(params.url, params.body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Cookie: params.cookieHeader,
      },
      // A successful login is a 302 to redirect_to; do NOT follow it, and don't throw on 3xx.
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 10000,
    });

    const setCookie = (response.headers['set-cookie'] as string[] | undefined) ?? [];
    return { status: response.status, setCookie };
  });
}

export class ManvfatSession implements IManvfatSession {
  private readonly teamId: number;
  private readonly clubUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly key: Buffer;
  private readonly jar: CookieJar;
  private readonly persistCookie: (teamId: number, encryptedJarBlob: string) => Promise<void>;
  private readonly loginRequest: LoginRequestFn;

  constructor(deps: ManvfatSessionDeps) {
    const { team, key, persistCookie, loginRequest } = deps;

    // FR-009 (scrape-time missing-credentials clause): fail fast with a ConfigError — distinct
    // from an AuthError — before any login attempt when the team has no stored credentials.
    if (!team.manvfatUsername || !team.manvfatPassword) {
      throw new ConfigError(
        `MAN v FAT credentials are not configured for team ${team.id}. ` +
          'Run "captain-stats init" with MANVFAT_USERNAME and MANVFAT_PASSWORD set in .env.'
      );
    }

    this.teamId = team.id;
    this.clubUrl = team.clubUrl;
    this.key = key;
    this.username = team.manvfatUsername;
    this.password = decryptSecret(team.manvfatPassword, key);
    this.persistCookie = persistCookie;
    this.loginRequest = loginRequest ?? defaultLoginRequest;
    this.jar = team.manvfatCookie
      ? CookieJar.deserializeSync(JSON.parse(decryptSecret(team.manvfatCookie, key)))
      : new CookieJar();
  }

  cookieHeader(url: string): string {
    return this.jar.getCookieStringSync(url);
  }

  hasCookie(url: string): boolean {
    return this.jar.getCookieStringSync(url).length > 0;
  }

  async login(): Promise<void> {
    const body = new URLSearchParams({
      log: this.username,
      pwd: this.password,
      'wp-submit': 'Log In',
      redirect_to: this.clubUrl,
      testcookie: '1',
      rememberme: 'forever',
    }).toString();

    const response = await this.loginRequest({
      url: MANVFAT_LOGIN_URL,
      body,
      cookieHeader: WP_TEST_COOKIE_HEADER,
    });

    const hasLoggedInCookie = response.setCookie.some((cookie) =>
      cookie.startsWith(LOGGED_IN_COOKIE_PREFIX)
    );

    // A non-302 (the login form re-rendered as 200) or a 302 without the logged-in cookie
    // means the credentials were rejected (research.md Finding 2).
    if (response.status !== 302 || !hasLoggedInCookie) {
      throw new AuthError(
        'MAN v FAT login failed: the site did not return an authenticated session. ' +
          'Check the MANVFAT_USERNAME / MANVFAT_PASSWORD configured for this team.'
      );
    }

    for (const cookie of response.setCookie) {
      this.jar.setCookieSync(cookie, MANVFAT_LOGIN_URL);
    }

    await this.persistCookie(
      this.teamId,
      encryptSecret(JSON.stringify(this.jar.serializeSync()), this.key)
    );
  }
}
