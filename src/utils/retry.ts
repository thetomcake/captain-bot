/**
 * Shared exponential backoff retry utility
 * Replaces inline retry logic in scraper and WhatsApp layers
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  retryableStatusCodes?: number[];
}

const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface AxiosLike {
  isAxiosError?: boolean;
  response?: { status: number };
  code?: string;
}

function isRetryableError(error: unknown, retryableStatusCodes: number[]): boolean {
  if (error instanceof Error) {
    const axiosErr = error as Error & AxiosLike;
    if (axiosErr.isAxiosError) {
      if (axiosErr.response) {
        const { status } = axiosErr.response;
        if (status >= 400 && status < 500) {
          return retryableStatusCodes.includes(status);
        }
        return status >= 500;
      }
      return true; // network error, no response
    }
  }
  return false;
}

/**
 * Execute a function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries - 1) break;

      if (!isRetryableError(error, retryableStatusCodes)) {
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError;
}
