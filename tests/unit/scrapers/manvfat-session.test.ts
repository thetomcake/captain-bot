import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';

import {
  ManvfatSession,
  type LoginRequestFn,
  type ManvfatSessionTeam,
} from '#src/scraping/manvfat-session.js';
import { encryptSecret } from '#src/utils/crypto.js';
import { AuthError, ConfigError } from '#src/utils/errors.js';

const CLUB_URL = 'https://manvfatfootball.com/club/watford/';

// A realistic 302 Set-Cookie set captured from the WordPress login handshake
// (research.md Finding 2): the path-`/` logged-in cookie is the one that matters;
// the admin-scoped sec cookie should NOT be sent when fetching the club page.
const SET_COOKIE_LOGGED_IN =
  'wordpress_logged_in_0123456789abcdef0123456789abcdef=player%40example.com%7C1799999999%7Ctoken%7Chash;' +
  ' path=/; secure; HttpOnly';
const SET_COOKIE_SEC =
  'wordpress_sec_0123456789abcdef=player%40example.com%7C1799999999%7Csec; path=/wp-admin; secure; HttpOnly';

const key = randomBytes(32);

const teamWith = (overrides: Partial<ManvfatSessionTeam> = {}): ManvfatSessionTeam => ({
  id: 1,
  clubUrl: CLUB_URL,
  manvfatUsername: 'player@example.com',
  manvfatPassword: encryptSecret('s3cret-pw', key),
  manvfatCookie: null,
  ...overrides,
});

const loginReturning = (status: number, setCookie: string[]): LoginRequestFn => {
  return async () => ({ status, setCookie });
};

describe('ManvfatSession (T010 — pure logic, injected login seam)', () => {
  describe('login() — Set-Cookie → jar', () => {
    it('populates the jar with wordpress_logged_in_* on a 302 and persists it', async () => {
      const persisted: Array<{ teamId: number; blob: string }> = [];
      const session = new ManvfatSession({
        team: teamWith(),
        key,
        persistCookie: async (teamId, blob) => {
          persisted.push({ teamId, blob });
        },
        loginRequest: loginReturning(302, [SET_COOKIE_LOGGED_IN, SET_COOKIE_SEC]),
      });

      await session.login();

      // The path-`/` logged-in cookie is now sent for the club page…
      expect(session.cookieHeader(CLUB_URL)).toContain('wordpress_logged_in');
      // …but the admin-scoped sec cookie (path=/wp-admin) is not.
      expect(session.cookieHeader(CLUB_URL)).not.toContain('wordpress_sec');

      // The encrypted serialized jar was persisted back to the team row.
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.teamId).toBe(1);
      expect(persisted[0]?.blob).not.toContain('wordpress_logged_in'); // encrypted, not plaintext
    });

    it('round-trips: a persisted (encrypted) jar reconstructs to the same cookie header', async () => {
      let storedBlob = '';
      const first = new ManvfatSession({
        team: teamWith(),
        key,
        persistCookie: async (_teamId, blob) => {
          storedBlob = blob;
        },
        loginRequest: loginReturning(302, [SET_COOKIE_LOGGED_IN]),
      });
      await first.login();

      // A fresh session built from the stored (encrypted) cookie blob — no login.
      const reconstructed = new ManvfatSession({
        team: teamWith({ manvfatCookie: storedBlob }),
        key,
        persistCookie: async () => {},
        loginRequest: loginReturning(302, []),
      });

      expect(reconstructed.cookieHeader(CLUB_URL)).toBe(first.cookieHeader(CLUB_URL));
      expect(reconstructed.cookieHeader(CLUB_URL)).toContain('wordpress_logged_in');
    });

    it('throws AuthError when the login form is re-rendered (200, no logged-in cookie)', async () => {
      const session = new ManvfatSession({
        team: teamWith(),
        key,
        persistCookie: async () => {},
        loginRequest: loginReturning(200, []),
      });

      await expect(session.login()).rejects.toBeInstanceOf(AuthError);
    });

    it('throws AuthError on a 302 that is missing the wordpress_logged_in_* cookie', async () => {
      const session = new ManvfatSession({
        team: teamWith(),
        key,
        persistCookie: async () => {},
        loginRequest: loginReturning(302, [SET_COOKIE_SEC]),
      });

      await expect(session.login()).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe('construction — missing credentials (FR-009 scrape-time clause)', () => {
    it('throws ConfigError when manvfatUsername is absent', () => {
      expect(
        () =>
          new ManvfatSession({
            team: teamWith({ manvfatUsername: null }),
            key,
            persistCookie: async () => {},
          })
      ).toThrow(ConfigError);
    });

    it('throws ConfigError when manvfatPassword is absent', () => {
      expect(
        () =>
          new ManvfatSession({
            team: teamWith({ manvfatPassword: null }),
            key,
            persistCookie: async () => {},
          })
      ).toThrow(ConfigError);
    });
  });

  describe('cookieHeader — empty jar', () => {
    it('is the empty string for a fresh session with no stored cookie', () => {
      // A fresh session carries no cookie; fetchHtml fetches anyway and the response-driven
      // isAuthenticated check (not cookie presence) drives the login (feature 005 T017a).
      const session = new ManvfatSession({
        team: teamWith(),
        key,
        persistCookie: async () => {},
      });

      expect(session.cookieHeader(CLUB_URL)).toBe('');
    });
  });
});
