import PQueue from 'p-queue';

export interface RateLimiterOptions {
  minDelay: number;
  maxConcurrent?: number;
}

export class RateLimiter {
  private readonly queue: PQueue;

  constructor(options: RateLimiterOptions) {
    this.queue = new PQueue({
      concurrency: options.maxConcurrent ?? Infinity,
      intervalCap: 1,
      interval: options.minDelay,
      strict: true,
    });
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.queue.add(fn);
    return result as T;
  }
}
