/**
 * Shared rate limiter for all outbound HTTP to the MAN v FAT site (feature 005).
 *
 * Politeness is a property of the target host, not of whichever module makes the call, so
 * BOTH the login POST (`manvfat-session.ts`) and the page GET (`fixture-scraper.ts`) pass
 * through this single queue. Enqueue at the **individual HTTP-request boundary** only — each
 * request takes exactly one token, so the configured cap (5 requests / minute) is enforced
 * for real (a single login-then-fetch operation is two requests, hence two tokens).
 *
 * IMPORTANT: never wrap a *composite* operation (e.g. "log in then fetch") in one token, and
 * never enqueue a task that itself awaits another enqueued task — under the concurrency cap a
 * queued task awaiting a queued task would starve. Wrap leaf HTTP calls, nothing higher.
 *
 * - intervalCap: 5 requests
 * - interval: 60000ms (1 minute)
 * - carryoverConcurrencyCount: strict rate limiting across intervals
 */

import PQueue from 'p-queue';

const requestQueue = new PQueue({
  intervalCap: 5,
  interval: 60000,
  carryoverConcurrencyCount: true,
});

/** Run a single HTTP request through the shared rate limiter. */
export function enqueueRequest<T>(request: () => Promise<T>): Promise<T> {
  return requestQueue.add(request) as Promise<T>;
}
