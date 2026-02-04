/**
 * Logger utility with configurable log levels via LOG_LEVEL environment variable.
 * Supports debug, info, warn, and error levels.
 * Includes automatic sanitization of sensitive data (API keys, tokens, etc.)
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, A3.1
 */

import { LogSanitizer } from "./log-sanitizer.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix?: string) {
    this.prefix = prefix ? `[${prefix}]` : "";
    this.level = this.parseLogLevel(process.env.LOG_LEVEL);
  }

  /**
   * Parse LOG_LEVEL environment variable, defaulting to "info"
   */
  private parseLogLevel(envLevel: string | undefined): LogLevel {
    if (!envLevel) {
      return "info";
    }

    const normalized = envLevel.toLowerCase() as LogLevel;
    if (normalized in LOG_LEVELS) {
      return normalized;
    }

    return "info";
  }

  /**
   * Check if a message at the given level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  /**
   * Format arguments for logging with automatic sanitization
   * Requirement A3.1: Sanitize sensitive data before logging
   */
  private formatArgs(args: unknown[]): string {
    const formatted = args
      .map((arg) => {
        if (typeof arg === "object" || Array.isArray(arg)) {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");

    // Sanitize the formatted string to redact sensitive data
    return LogSanitizer.sanitize(formatted);
  }

  /**
   * Log debug messages (lowest priority)
   * Only logged when LOG_LEVEL=debug
   */
  debug(...args: unknown[]): void {
    if (this.shouldLog("debug")) {
      const message = this.formatArgs(args);
      console.log(`${this.prefix}[DEBUG]`, message);
    }
  }

  /**
   * Log info messages
   * Logged when LOG_LEVEL=debug or LOG_LEVEL=info (default)
   */
  info(...args: unknown[]): void {
    if (this.shouldLog("info")) {
      const message = this.formatArgs(args);
      console.log(`${this.prefix}[INFO]`, message);
    }
  }

  /**
   * Log warning messages
   * Logged when LOG_LEVEL=debug, info, or warn
   */
  warn(...args: unknown[]): void {
    if (this.shouldLog("warn")) {
      const message = this.formatArgs(args);
      console.warn(`${this.prefix}[WARN]`, message);
    }
  }

  /**
   * Log error messages (highest priority)
   * Always logged unless LOG_LEVEL is invalid
   */
  error(...args: unknown[]): void {
    if (this.shouldLog("error")) {
      const message = this.formatArgs(args);
      console.error(`${this.prefix}[ERROR]`, message);
    }
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Set the log level programmatically (useful for testing)
   */
  setLevel(level: LogLevel): void {
    if (level in LOG_LEVELS) {
      this.level = level;
    }
  }
}

// Singleton logger instance
export const logger = new Logger();
