import { LogSanitizer } from "./security/log-sanitizer.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * How much of an error is written, and why each bound is where it is.
 *
 * `CAUSE_DEPTH`: a wrapped error is normally two or three links deep
 * (`fetch failed` -> `ConnectionRefused`); four covers that with room to spare
 * and stops a hostile or accidental chain from filling the log. Cycles are
 * caught separately — a bound alone would still print the same error four
 * times.
 *
 * `STACK_FRAMES`: enough to say WHERE, few enough to keep the event on one
 * line; see `topFrames`.
 *
 * `AGGREGATE_ERRORS`: an `AggregateError` from a batch can hold one entry per
 * item, and a hundred of them would bury the line that matters.
 */
const MAX_CAUSE_DEPTH = 4;
const MAX_STACK_FRAMES = 3;
const MAX_AGGREGATE_ERRORS = 3;

/**
 * The separator between one error's parts. A pipe rather than a newline: an
 * MCP client reads this server's stderr line by line, so a failure has to stay
 * ONE record to stay one event.
 */
const PART_SEPARATOR = " | ";

/**
 * `JSON.stringify` that answers null instead of throwing or returning
 * `undefined` — a `BigInt` throws, and a `toJSON` returning nothing yields
 * `undefined`, neither of which is a string the caller can print.
 */
function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

/**
 * An error's own enumerable properties, minus the ones `formatError` already
 * prints by name.
 *
 * These are the one thing the old `JSON.stringify(error)` DID preserve, and
 * they are not incidental: measured on Bun 1.3.14, a refused connection throws
 * an `Error` whose message is the vague "Unable to connect. Is the computer
 * able to access the url?" while `{"code":"ConnectionRefused","path":…,
 * "errno":0}` — the part an operator acts on — lives here. Dropping them would
 * have replaced one silent failure with another.
 *
 * They are reproduced EXACTLY as `JSON.stringify(error)` produced them, `path`
 * included, so this formatter writes no field the old one did not. The
 * sanitizer sees the result either way; what it does and does not catch is its
 * own contract, unchanged here.
 *
 * `errors` is skipped only when it is an array, i.e. only when `aggregateOf`
 * has already printed it.
 */
function errorDetails(error: Error): string | null {
  const extra: Record<string, unknown> = {};
  const source = error as unknown as Record<string, unknown>;

  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
    if (key === "errors" && Array.isArray(source[key])) continue;
    extra[key] = source[key];
  }

  return Object.keys(extra).length === 0 ? null : safeJson(extra);
}

/**
 * The innermost stack frames, on ONE line.
 *
 * Deliberately NOT the whole stack. This logger writes to stderr, which an MCP
 * client captures line by line, and CLAUDE.md's rule is one event per line: a
 * twenty-frame dump turns a single failure into twenty log records and repeats
 * the `name: message` header the caller already has. Three frames is what it
 * takes to name the failing function and who called it — the question
 * `magic_logo_search query "x" failed unexpectedly` cannot answer on its own.
 *
 * Frames are recognised by the V8 shape (`    at fn (file:line:col)`), which
 * Bun 1.3.14 emits. Anything else degrades to no frames rather than to noise —
 * and there is genuinely something else: a `DOMException` (Bun's `AbortError`)
 * has NO `stack` at all, which is why the type is checked rather than assumed.
 */
function topFrames(stack: unknown): string | null {
  if (typeof stack !== "string") return null;

  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_STACK_FRAMES);

  return frames.length === 0 ? null : frames.join("; ");
}

/**
 * The members of an `AggregateError`, or null when there are none to print.
 * Duck-typed rather than `instanceof AggregateError`, so any error carrying an
 * `errors` array — `pool`'s, a library's — reads the same.
 */
function aggregateOf(error: Error): unknown[] | null {
  const errors = (error as unknown as Record<string, unknown>).errors;
  return Array.isArray(errors) && errors.length > 0 ? errors : null;
}

/** `errors: [first; second; +N more]`, bounded by `MAX_AGGREGATE_ERRORS`. */
function formatAggregate(members: unknown[], seen: Set<unknown>, depth: number): string {
  const shown = members
    .slice(0, MAX_AGGREGATE_ERRORS)
    .map((member) => formatValue(member, seen, depth + 1));
  const hidden = members.length - shown.length;

  return `errors: [${shown.join("; ")}${hidden > 0 ? `; +${hidden} more` : ""}]`;
}

/**
 * One error on one line: `Name: message | {own props} | at frame; at frame |
 * errors: [...] | caused by: ...`.
 *
 * `seen` holds the errors on the CURRENT path only — added before recursing,
 * removed after — so a genuine cycle (`error.cause === error`) is cut while
 * two siblings that happen to be the same object still both print.
 */
function formatError(error: Error, seen: Set<unknown>, depth: number): string {
  if (seen.has(error)) return "<circular>";
  seen.add(error);

  const name = typeof error.name === "string" && error.name.length > 0 ? error.name : "Error";
  const parts = [`${name}: ${String(error.message)}`];

  const details = errorDetails(error);
  if (details !== null) parts.push(details);

  const frames = topFrames(error.stack);
  if (frames !== null) parts.push(frames);

  const aggregate = aggregateOf(error);
  if (aggregate !== null) parts.push(formatAggregate(aggregate, seen, depth));

  if (error.cause !== undefined) {
    parts.push(
      depth < MAX_CAUSE_DEPTH
        ? `caused by: ${formatValue(error.cause, seen, depth + 1)}`
        : "caused by: <cause depth limit reached>"
    );
  }

  seen.delete(error);
  return parts.join(PART_SEPARATOR);
}

/**
 * Any logged value as text.
 *
 * An `Error` is special-cased because `JSON.stringify` DESTROYS one: `message`,
 * `stack` and `cause` are non-enumerable, so `JSON.stringify(new Error("BOOM"))`
 * is the string `"{}"` — measured on Bun 1.3.14. Seven call sites pass an error
 * here, and every one of them was logging `{}` while telling the client "the
 * server log has the detail" (R2.3). A thrown non-`Error` — a string, a plain
 * object, `null` — still formats exactly as it did.
 */
function formatValue(value: unknown, seen: Set<unknown>, depth: number): string {
  // `instanceof Error` also covers Bun's `DOMException`, which the `AbortError`
  // path throws and which `JSON.stringify` empties just the same.
  if (value instanceof Error) return formatError(value, seen, depth);
  if (typeof value === "object" && value !== null) return safeJson(value) ?? String(value);
  return String(value);
}

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

  /**
   * Every argument as one sanitized line. The sanitizer runs LAST, over the
   * whole joined string, so an error's message, own properties and `cause`
   * are redacted on exactly the same terms as any other logged text.
   */
  private formatArgs(args: unknown[]): string {
    const formatted = args.map((arg) => formatValue(arg, new Set(), 0)).join(" ");

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
