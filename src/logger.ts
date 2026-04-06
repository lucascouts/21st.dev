import { LogSanitizer } from "./security/log-sanitizer.js";

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

  constructor(level: LogLevel, prefix?: string) {
    this.level = level;
    this.prefix = prefix ? `[${prefix}]` : "";
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

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

    return LogSanitizer.sanitize(formatted);
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog("debug")) {
      const message = this.formatArgs(args);
      process.stderr.write(`${this.prefix}[DEBUG] ${message}\n`);
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLog("info")) {
      const message = this.formatArgs(args);
      process.stderr.write(`${this.prefix}[INFO] ${message}\n`);
    }
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog("warn")) {
      const message = this.formatArgs(args);
      process.stderr.write(`${this.prefix}[WARN] ${message}\n`);
    }
  }

  error(...args: unknown[]): void {
    if (this.shouldLog("error")) {
      const message = this.formatArgs(args);
      process.stderr.write(`${this.prefix}[ERROR] ${message}\n`);
    }
  }

  getLevel(): LogLevel {
    return this.level;
  }
}
