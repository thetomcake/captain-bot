/**
 * Logging infrastructure for Captain Stats
 */

import fs from 'fs';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  level: LogLevel;
  file?: string;
  console: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel;
  private file?: string;
  private consoleEnabled: boolean;
  private fileStream?: fs.WriteStream;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.file = options.file;
    this.consoleEnabled = options.console;

    if (this.file) {
      const logDir = path.dirname(this.file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      this.fileStream = fs.createWriteStream(this.file, { flags: 'a' });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const metaString = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaString}`;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, message, meta);

    if (this.consoleEnabled) {
      const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      consoleMethod(formatted);
    }

    if (this.fileStream) {
      this.fileStream.write(formatted + '\n');
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const errorMeta = error
      ? {
          ...meta,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        }
      : meta;

    this.write('error', message, errorMeta);
  }

  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
    }
  }
}

// Default logger instance
let defaultLogger: Logger | null = null;

/**
 * Initialize the default logger
 */
export function initLogger(options: LoggerOptions): Logger {
  defaultLogger = new Logger(options);
  return defaultLogger;
}

/**
 * Get the default logger instance
 */
export function getLogger(): Logger {
  if (!defaultLogger) {
    // Create a basic console logger if not initialized
    defaultLogger = new Logger({
      level: 'info',
      console: true,
    });
  }
  return defaultLogger;
}

/**
 * Create a new logger instance with custom options
 */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}

// Convenience exports
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => getLogger().debug(message, meta),
  info: (message: string, meta?: Record<string, unknown>) => getLogger().info(message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => getLogger().warn(message, meta),
  error: (message: string, error?: Error, meta?: Record<string, unknown>) =>
    getLogger().error(message, error, meta),
  close: () => getLogger().close(),
};
