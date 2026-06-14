// Decoupled rate limiter for the WhatsApp Gateway (FR-002, FR-016).
//
// Mirrors the MVP's `src/utils/rate-limiter.ts` pattern (p-queue, ≤5 msg/min) but
// is owned by the library so the gateway has no dependency on MVP code (FR-002).
// p-queue with intervalCap=1 over `minDelay` enforces at most one task per
// interval; `strict` keeps the spacing honest under bursts.
import PQueue from 'p-queue';

export interface RateLimiterOptions {
  /** Minimum spacing between executed tasks, in milliseconds. */
  minDelay: number;
  /** Maximum concurrent tasks; defaults to `1` (serial). Never unbounded — a rate
   *  limiter must cap in-flight work even when a task outlives the spacing interval. */
  maxConcurrent?: number;
}

export class RateLimiter {
  private readonly queue: PQueue;

  constructor(options: RateLimiterOptions) {
    this.queue = new PQueue({
      concurrency: options.maxConcurrent ?? 1,
      intervalCap: 1,
      interval: options.minDelay,
      strict: true,
    });
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn);
  }
}
