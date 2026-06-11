/**
 * Error handling utilities and custom error classes
 */

/**
 * Base application error class
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, code: string, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration error (missing or invalid config)
 */
export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 2);
  }
}

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', 3);
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * WhatsApp connection error
 */
export class WhatsAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'WHATSAPP_ERROR', 4);
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * Scraping error (website unavailable or structure changed)
 */
export class ScrapingError extends AppError {
  constructor(message: string, url?: string) {
    const fullMessage = url ? `${message} (URL: ${url})` : message;
    super(fullMessage, 'SCRAPING_ERROR', 4);
  }
}

/**
 * Not found error
 */
export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    const message = identifier
      ? `${resource} not found: ${identifier}`
      : `${resource} not found`;
    super(message, 'NOT_FOUND', 1);
  }
}

/**
 * Validation error (invalid input)
 */
export class ValidationError extends AppError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR', 2);
    this.field = field;
  }
}

/**
 * Rate limit error
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message, 'RATE_LIMIT_ERROR', 4);
    this.retryAfter = retryAfterSeconds;
  }
}

/**
 * Check if an error is operational (expected) vs programming error
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Format error for user display
 */
export function formatErrorForUser(error: Error): string {
  if (error instanceof AppError) {
    return error.message;
  }

  // Don't expose internal error details to users
  return 'An unexpected error occurred. Please check the logs for details.';
}

/**
 * Format error for logging
 */
export function formatErrorForLog(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error instanceof AppError && {
      code: error.code,
      statusCode: error.statusCode,
      isOperational: error.isOperational,
    }),
  };
}

/**
 * Error handler for async functions
 */
export function asyncHandler<T>(
  fn: (...args: unknown[]) => Promise<T>
): (...args: unknown[]) => Promise<T> {
  return async (...args: unknown[]): Promise<T> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new AppError('Unknown error occurred', 'UNKNOWN_ERROR', 500, false);
    }
  };
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if it's not an operational error
      if (!isOperationalError(lastError)) {
        throw lastError;
      }

      // Calculate exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);

      // Wait before retrying (unless it's the last attempt)
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
