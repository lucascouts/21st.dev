import type { z } from "zod";
import type { Logger } from "../logger.js";
import { failureLogDetail, type FailureKind } from "./failure.js";

/**
 * The shared HTTP client: it hands back a body that SATISFIED A SCHEMA, or a
 * named failure — never a value nobody checked (story 006, R1.1-R1.5, R2.3).
 *
 * The signature is the fix. A schema is a required parameter, so a caller cannot
 * obtain a body without one, and the result is a discriminated union, so there
 * is no slot left for the cast this file used to return a null through: `ok:
 * true` and `data === null` can no longer be the same value, because the failure
 * branch has no `data` property to put a lie in.
 *
 * What the previous shape cost, measured 2026-08-12 on Bun 1.3.14:
 *
 * - a `{}` body yielded `undefined` for every field read, and a non-JSON 200 or
 *   an interrupted body yielded `data === null` alongside `ok === true`, so the
 *   first field read raised a `TypeError` somewhere else, later, in the
 *   vocabulary of a JavaScript engine;
 * - a 50 MiB body was read whole in 62 ms, taking RSS to 303 MB;
 * - a `302` to a second local server returned THAT server's body with
 *   `ok: true`, and the caller could not tell.
 *
 * **The abort timer is deliberately left exactly where it was.** `clearTimeout`
 * sits in a `finally` that runs after the body read completes inside the `try`,
 * so the timer is armed for the whole attempt — fetch, redirect chain, body read
 * and validation. The sibling defect story 005 found in `logo-search`, where the
 * timer was cleared before the body was read, is ABSENT here. This is written
 * down because the obvious assumption is that both files share it; they do not.
 */

/** 1 MiB, the same default `Config.maxBodySize` carries and the value `src/index.ts` passes in. */
const DEFAULT_MAX_BODY_SIZE = 1_048_576;

/**
 * How many redirects one request may follow. Five matches `logo-search`, whose
 * manual-follow shape this reuses; the sixth fails the call rather than being
 * followed.
 */
const MAX_REDIRECTS = 5;

/** The statuses that carry a `Location` meant to be followed. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * How much of an unreadable body reaches the LOG.
 *
 * The bytes are remote text, and the log is the half of the split that may carry
 * it (R2.3) — the client-facing message never does. The cap is what keeps one
 * failure to one line and one line to a readable length; `failureLogDetail`
 * quotes it, so a newline in it cannot forge a second log entry.
 */
const MAX_LOGGED_BODY_CHARS = 120;

/** How many schema issues one log line names before it summarises the rest. */
const MAX_REPORTED_ISSUES = 3;

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitterMax: number;
}

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout: number;
  retry: RetryConfig;
  logger: Logger;
  /**
   * The most bytes one response body may contribute, defaulting to
   * `DEFAULT_MAX_BODY_SIZE`.
   *
   * Optional rather than required so the bound is a setting an operator raises,
   * not a field every construction site has to restate — and so omitting it
   * yields the configured default rather than an unbounded read.
   */
  maxBodySize?: number;
}

/**
 * One call's outcome, as design.md Fix Approach 1 states it.
 *
 * `ok: true` implies `data` satisfied the schema. Nothing else in this file may
 * produce a `data` property, so an absent, unreadable, oversize, misrouted or
 * unvalidated body is reported as a KIND and carries no value at all.
 */
export type HttpResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly kind: FailureKind };

/**
 * Which thrown errors are RETRIED. Deliberately unchanged: it decides timing,
 * not vocabulary, and broadening it would alter how long every failing call
 * takes — a behaviour change this bugfix does not make. Measured: a refused
 * connection on Bun 1.3.14 is a plain `Error` with `code: "ConnectionRefused"`
 * and the message "Unable to connect…", so it matches nothing here and is not
 * retried. It is still REPORTED as `network` below, which is what it is.
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("etimedout")
    );
  }
  return false;
}

/**
 * The timeout's own signature. Measured: aborting a Bun `fetch` rejects with a
 * `DOMException` named `AbortError`, which is not an `Error` subclass on every
 * runtime — so the NAME is read defensively rather than through `instanceof`.
 */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function calculateBackoff(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * config.jitterMax;
  return Math.min(delay + jitter, config.maxDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A URL's origin, or null when the string is not a URL at all. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The `Location` of a redirect this client follows, or null when the response is
 * not one. A 3xx WITHOUT a `Location` is not a redirect — `304` is the ordinary
 * case — and is handed on as the final response instead.
 */
function redirectLocationOf(response: Response): string | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  if (location === null || location.trim().length === 0) return null;
  return location;
}

/**
 * A `Location` resolved against the URL that produced it, or null when it cannot
 * be. `Location` is very often relative (`/api/fetch-ui/v2`), and an origin
 * check on a string with no origin in it would refuse a legitimate hop.
 */
function resolveLocation(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

/**
 * Whether the next hop must become a bodyless `GET`.
 *
 * `fetch`'s own `follow` mode applies this rule, so following manually has to
 * apply it too — otherwise a `303 See Other` answer to a `POST` would resubmit
 * the body instead of reading the result. `307` and `308` exist precisely to say
 * "repeat the method", so they keep it.
 */
function rewritesToGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";
  return (status === 301 || status === 302) && method === "POST";
}

/**
 * Release a response whose body this client will not read.
 *
 * Every non-success path ends here, so an error status or a refused redirect
 * does not leave a socket held open waiting for bytes nobody wants. A rejected
 * cancellation is itself nothing to report: the body is already being discarded.
 */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** The bytes of a bounded read, joined once at the end. */
function decode(chunks: readonly Uint8Array[], total: number): string {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** The head of a body, for the log line only, capped so one failure stays one line. */
function preview(text: string): string {
  return text.length > MAX_LOGGED_BODY_CHARS ? `${text.slice(0, MAX_LOGGED_BODY_CHARS)}…` : text;
}

/**
 * Where each schema issue occurred and what kind it was — NEVER the value that
 * failed. A response can carry a credential in any field, so quoting the input
 * back into the log is the one thing this must not do (the construction story
 * 005 already uses in `logo-search`).
 */
function describeIssues(error: z.ZodError): string {
  const descriptors = error.issues.map((issue) => {
    // `String` per segment rather than `join` directly: array indices arrive as
    // numbers, and a symbol segment would make `join` raise.
    const where = issue.path.map((segment) => String(segment)).join(".");
    return `${where.length > 0 ? where : "(root)"}: ${issue.code}`;
  });
  const reported = descriptors.slice(0, MAX_REPORTED_ISSUES);
  const remaining = descriptors.length - reported.length;
  const summary = reported.join("; ");
  return remaining > 0 ? `${summary} (+${remaining} more)` : summary;
}

/** A schema verdict with the failure reduced to text that is safe to log. */
type Verdict<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

/**
 * Run the caller's schema without letting it throw across the boundary.
 *
 * `safeParse` returns its verdict rather than raising, but a schema carrying an
 * async refinement raises anyway — and an engine-internal string escaping this
 * client is the very defect R2 exists to close.
 */
function validate<T>(schema: z.ZodType<T>, value: unknown): Verdict<T> {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, detail: describeIssues(parsed.error) };
  } catch (error) {
    return { ok: false, detail: `the schema could not be run: ${messageOf(error)}` };
  }
}

/** One hop's ending: a response to read, or a refusal to report. */
type HopOutcome =
  | { readonly ok: true; readonly response: Response }
  | {
      readonly ok: false;
      readonly status: number;
      readonly kind: FailureKind;
      readonly detail: string;
    };

/** A bounded body read: the text, or the kind of failure that stopped it. */
type BodyRead =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly kind: Extract<FailureKind, "too_large" | "unreadable_body">;
      readonly detail: string;
    };

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly retry: RetryConfig;
  private readonly logger: Logger;
  private readonly maxBodySize: number;
  /**
   * The one origin this client will accept a body from, resolved once. Null when
   * `baseUrl` is not a URL at all, which makes every call fail closed instead of
   * making the origin check vacuous.
   */
  private readonly baseOrigin: string | null;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeout = config.timeout;
    this.retry = config.retry;
    this.logger = config.logger;
    this.maxBodySize = config.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
    this.baseOrigin = originOf(config.baseUrl);
  }

  async get<T>(endpoint: string, schema: z.ZodType<T>): Promise<HttpResult<T>> {
    return this.request("GET", endpoint, schema, undefined);
  }

  async post<T>(endpoint: string, body: unknown, schema: z.ZodType<T>): Promise<HttpResult<T>> {
    return this.request("POST", endpoint, schema, body);
  }

  async put<T>(endpoint: string, body: unknown, schema: z.ZodType<T>): Promise<HttpResult<T>> {
    return this.request("PUT", endpoint, schema, body);
  }

  async delete<T>(endpoint: string, body: unknown, schema: z.ZodType<T>): Promise<HttpResult<T>> {
    return this.request("DELETE", endpoint, schema, body);
  }

  async patch<T>(endpoint: string, body: unknown, schema: z.ZodType<T>): Promise<HttpResult<T>> {
    return this.request("PATCH", endpoint, schema, body);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    schema: z.ZodType<T>,
    body: unknown
  ): Promise<HttpResult<T>> {
    const url = `${this.baseUrl}${endpoint}`;

    // The first hop is held to the same rule every later hop is: a request this
    // client issues goes to the configured service or it is not issued.
    const origin = originOf(url);
    if (this.baseOrigin === null || origin !== this.baseOrigin) {
      return this.failed(0, "network", `request origin ${origin ?? "unparseable"} is not the configured base`);
    }

    // Serialised once, before the loop, so a retry or a redirect does not repeat
    // the work and so a body that cannot be serialised fails before anything is
    // sent rather than from inside an attempt.
    let payload: string | null = null;
    if (body !== undefined) {
      try {
        payload = JSON.stringify(body);
      } catch (error) {
        return this.failed(0, "network", `the request body could not be serialised: ${messageOf(error)}`);
      }
    }

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        this.logger.debug(`HTTP ${method} ${url} (attempt ${attempt + 1})`);

        const hop = await this.fetchChain(method, url, payload, controller.signal);
        if (!hop.ok) return this.failed(hop.status, hop.kind, hop.detail);

        const response = hop.response;

        // 5xx — retry, until the budget is spent and it becomes the ending below.
        if (response.status >= 500 && attempt < this.retry.maxRetries) {
          discardBody(response);
          this.record("http_error", statusDetail(response));
          await this.waitBeforeRetry(endpoint, attempt);
          continue;
        }

        // Any non-2xx ending. The body is NOT read: an error status produces no
        // value, so there is nothing here for an unvalidated one to ride out on
        // — the branch this file used to feed through `safeJson`.
        if (!response.ok) {
          discardBody(response);
          return this.failed(response.status, "http_error", statusDetail(response));
        }

        return await this.readValidated(response, schema);
      } catch (error) {
        // The abort timer fires into the fetch AND into the body read, so a
        // timeout is claimed here first: it owns the outcome whichever of the
        // two it interrupted.
        if (isAbortError(error)) {
          return this.failed(0, "timeout", `${this.timeout}ms budget elapsed`);
        }

        if (isNetworkError(error) && attempt < this.retry.maxRetries) {
          this.record("network", messageOf(error));
          await this.waitBeforeRetry(endpoint, attempt);
          continue;
        }

        return this.failed(0, "network", messageOf(error));
      } finally {
        // Left exactly where it was: this runs AFTER the body read above, so the
        // timer is armed for the whole attempt. See the file header.
        clearTimeout(timeoutId);
      }
    }

    // Reached only when the loop never ran, i.e. a negative `maxRetries`. No
    // request was made, so the connection is the thing that did not happen.
    return this.failed(0, "network", "no attempt was made: maxRetries is below zero");
  }

  /**
   * Follow redirects MANUALLY, refusing any hop that leaves the configured
   * origin (R1.5).
   *
   * `fetch` defaults to `redirect: "follow"`, which makes the origin of a body a
   * property of the RESPONSE CHAIN rather than of the service that was asked.
   * Measured: a `302` to a second local server returned that server's body with
   * `ok: true` and no way for the caller to tell. `redirect: "manual"` was
   * measured on Bun 1.3.14 to return the 3xx with a readable `Location`, so every
   * hop can be judged before it is requested — the shape story 005 already uses
   * in `logo-search`, with "same origin as `baseUrl`" in place of its
   * address-range guard.
   *
   * Note the measured NON-finding: Bun strips `Authorization` on a cross-origin
   * hop, so this is not a credential leak. It is a provenance defect — the schema
   * alone would happily validate a well-formed body from an unintended host.
   */
  private async fetchChain(
    method: string,
    url: string,
    payload: string | null,
    signal: AbortSignal
  ): Promise<HopOutcome> {
    let target = url;
    let hopMethod = method;
    let hopPayload = payload;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(target, {
        method: hopMethod,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal,
        redirect: "manual",
        ...(hopPayload !== null ? { body: hopPayload } : {}),
      });

      const location = redirectLocationOf(response);
      if (location === null) return { ok: true, response };

      discardBody(response);

      const next = resolveLocation(location, target);
      if (next === null) {
        // The `Location` itself is withheld: it is remote text and can carry a
        // credential just as a URL can.
        return {
          ok: false,
          status: response.status,
          kind: "redirect_refused",
          detail: "the redirect target could not be resolved",
        };
      }

      const nextOrigin = originOf(next);
      if (nextOrigin !== this.baseOrigin) {
        // The ORIGIN only, per design.md: it names the host without carrying the
        // path, query or userinfo the target may have been given.
        return {
          ok: false,
          status: response.status,
          kind: "redirect_refused",
          detail: `target origin ${nextOrigin ?? "unparseable"}`,
        };
      }

      if (rewritesToGet(response.status, hopMethod)) {
        hopMethod = "GET";
        hopPayload = null;
      }
      target = next;
    }

    return {
      ok: false,
      status: 0,
      kind: "redirect_refused",
      detail: `the redirect chain exceeded ${MAX_REDIRECTS} hops`,
    };
  }

  /**
   * The only path in this file that produces a value, and the schema runs on all
   * of it: bytes are bounded, then decoded, then parsed, then validated. A stop
   * at any of those four is a KIND, never a value.
   */
  private async readValidated<T>(response: Response, schema: z.ZodType<T>): Promise<HttpResult<T>> {
    const body = await this.readBounded(response);
    if (!body.ok) return this.failed(response.status, body.kind, body.detail);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return this.failed(response.status, "unreadable_body", `not JSON: ${preview(body.text)}`);
    }

    const verdict = validate(schema, parsed);
    if (!verdict.ok) return this.failed(response.status, "schema_mismatch", verdict.detail);

    return { ok: true, status: response.status, data: verdict.value };
  }

  /**
   * Read at most `maxBodySize` bytes, and abandon the read the moment more
   * arrive (R1.4).
   *
   * The bound is checked TWICE, against two different things. `content-length`
   * is cheap and stops an oversize body before a byte of it is read — but it is
   * REMOTE-SUPPLIED and may lie: measured, a hand-written response declaring
   * `Content-Length: 12` alongside chunked framing delivered ~200 KB, and Bun's
   * `fetch` delivered all of it. So the accumulated bytes are counted regardless,
   * which is the check that cannot be talked out of. Measured on a 50 MiB body:
   * the read stops after 2 chunks and 27 ms at 149 MB RSS, against 62 ms and
   * 303 MB for reading it whole.
   */
  private async readBounded(response: Response): Promise<BodyRead> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBodySize) {
      discardBody(response);
      return {
        ok: false,
        kind: "too_large",
        detail: `content-length ${declared} over the ${this.maxBodySize} byte limit`,
      };
    }

    const stream = response.body;
    if (stream === null) return { ok: true, text: "" };

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        total += value.byteLength;

        if (total > this.maxBodySize) {
          await reader.cancel().catch(() => {});
          return {
            ok: false,
            kind: "too_large",
            detail: `read ${total} bytes, over the ${this.maxBodySize} byte limit`,
          };
        }
      }
    } catch (error) {
      // A read interrupted by the deadline is the deadline's outcome, not the
      // body's: rethrown so the caller reports `timeout` rather than blaming the
      // response for a clock this client set.
      if (isAbortError(error)) throw error;
      // Everything else is a body that did not arrive whole — measured: a reply
      // cut short of its declared `Content-Length` rejects with `ECONNRESET`,
      // which the old `safeJson` swallowed into a null cast to the caller's type.
      return { ok: false, kind: "unreadable_body", detail: messageOf(error) };
    }

    return { ok: true, text: decode(chunks, total) };
  }

  /** Hold the retry backoff, saying so without repeating anything remote. */
  private async waitBeforeRetry(endpoint: string, attempt: number): Promise<void> {
    const delay = calculateBackoff(attempt, this.retry);
    this.logger.warn(
      `${endpoint} failed, retrying in ${Math.round(delay)}ms (${attempt + 1}/${this.retry.maxRetries})`
    );
    await sleep(delay);
  }

  /**
   * The local half of the split (R2.3): what actually happened, remote text
   * included, at `error` — so failing closed does not also mean failing
   * silently. The caller-facing half is the KIND alone, and it never travels
   * through here.
   */
  private record(kind: FailureKind, detail: string): void {
    this.logger.error(failureLogDetail(kind, detail));
  }

  /**
   * Record the detail and hand back the failure.
   *
   * Typed `HttpResult<never>` because a failure carries no value: `never` is
   * assignable to every `T`, so one failure fits every call's result type
   * without a cast, which is the point of removing them from this file.
   */
  private failed(status: number, kind: FailureKind, detail: string): HttpResult<never> {
    this.record(kind, detail);
    return { ok: false, status, kind };
  }
}

/**
 * What an error status is worth logging: the status and the remote reason
 * phrase, per design.md's table. Both are remote-supplied, which is exactly why
 * they belong in this half and not in the message the caller is given.
 */
function statusDetail(response: Response): string {
  return `status ${response.status} ${response.statusText}`;
}
