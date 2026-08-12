import type { CorsHandler, OriginCheckOptions } from "./cors.js";
import { parseCallbackPayload, type CallbackPayload } from "./callback-payload.js";
import type { RateLimiter, RateLimitResult } from "../security/rate-limiter.js";
import type { Logger } from "../logger.js";

export interface CallbackServerConfig {
  maxBodySize: number;
  cors: typeof CorsHandler;
  rateLimiter: RateLimiter;
  logger: Logger;
  /**
   * Admit loopback origins (R4.2). Optional, and absent means off: the callback
   * answers the issuing service only unless an operator says otherwise.
   */
  allowLocalhostOrigin?: boolean | undefined;
}

/**
 * What the single-use callback window produced.
 *
 * Neither field is `req.text()` verbatim any more (R4.3): a body becomes a
 * result only once `callback-payload.ts` accepts it, so what is carried here is
 * the declared fields and nothing else.
 *
 * - `payload` is the validated payload as a STRUCTURE. It is what both tools
 *   render, and it is why the channel a value belongs to no longer has to be
 *   read out of the value itself (R4.4) — the tool receives a typed thing, not
 *   a string it must inspect.
 * - `data` is that same payload serialized: the result as text, for a caller
 *   that consumes the callback as text rather than as fields.
 */
export type CallbackResult =
  | { ok: true; data: string; payload: CallbackPayload }
  | { ok: false; reason: "timeout" | "cancelled" | "error"; message?: string };

/**
 * What a payload says when it carries nothing to render. Unreachable through
 * `parseCallbackPayload` — see `payloadSnippet` — and a constant of ours, never
 * remote text.
 */
const NOTHING_RENDERABLE = "The callback returned no content.";

/**
 * The content a tool shows for a validated payload.
 *
 * WHY A TOOL MUST NOT SHOW THE PAYLOAD ITSELF. Measured 2026-08-12, driving
 * both tools with a real callback POST of
 * `{"text":"export const Card = () => <div/>;"}`: the agent received that JSON
 * object, envelope and all, where the snippet alone used to arrive. The
 * envelope is this project's own vocabulary for what may cross the boundary;
 * the caller asked for a component.
 *
 * ORDER, AND WHY. `text` first: it is the callback's counterpart of
 * `textResponseSchema.text`, the field `create-ui` already renders through
 * `formatResponse` on the API path, so the two paths agree on what a result is.
 * `code` next — the same content under the other name the callback may use.
 * `component` is not a snippet but a NAME, and a name is not meaningful without
 * the `props` that qualify it, so that pair is rendered as the structure it
 * really is instead of as a bare word.
 *
 * TOTAL BY CONSTRUCTION. `callbackPayloadSchema` refuses a payload carrying
 * none of the three, so the final return cannot be reached through the server.
 * It exists because each field's TYPE is `string | undefined` — something the
 * `.refine` at the boundary knows and the type system does not — and returning
 * a named constant is the honest ending for a case that would otherwise have to
 * be asserted away.
 *
 * It lives beside `CallbackResult` rather than in `callback-payload.ts` for two
 * reasons: that file states what may CROSS the boundary, while this is a
 * consumer's decision about what to SHOW; and both tools already import this
 * module, so one definition serves both instead of drifting into two.
 */
export function payloadSnippet(payload: CallbackPayload): string {
  if (payload.text !== undefined) return payload.text;
  if (payload.code !== undefined) return payload.code;
  if (payload.component !== undefined) {
    const described =
      payload.props === undefined
        ? { component: payload.component }
        : { component: payload.component, props: payload.props };
    return JSON.stringify(described, null, 2);
  }
  return NOTHING_RENDERABLE;
}

export class CallbackServer {
  private readonly maxBodySize: number;
  private readonly cors: typeof CorsHandler;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  /**
   * Read only by `originAllowed` and `corsHeadersFor`, never at a call site.
   * A request is one origin decision; splitting it across two calls that could
   * be given different options is how a refusal and a grant come to disagree.
   */
  private readonly originOptions: OriginCheckOptions;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private resolve: ((result: CallbackResult) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CallbackServerConfig) {
    this.maxBodySize = config.maxBodySize;
    this.cors = config.cors;
    this.rateLimiter = config.rateLimiter;
    this.logger = config.logger;
    this.originOptions = { allowLocalhost: config.allowLocalhostOrigin === true };
  }

  async start(): Promise<number> {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handleRequest(req),
    });

    const port = this.server.port!;
    this.logger.info(`CallbackServer listening on port ${port}`);
    return port;
  }

  waitForCallback(timeoutMs: number): Promise<CallbackResult> {
    return new Promise<CallbackResult>((resolve) => {
      this.resolve = resolve;

      this.timeoutId = setTimeout(() => {
        this.logger.info("CallbackServer timeout reached");
        this.stop();
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
  }

  cancel(): void {
    this.stop();
    if (this.resolve) {
      this.resolve({ ok: false, reason: "cancelled" });
      this.resolve = null;
    }
  }

  private stop(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  /** May this origin answer the callback? The server's own configured question. */
  private originAllowed(origin: string | undefined): boolean {
    return this.cors.isAllowedOrigin(origin, this.originOptions);
  }

  /** The CORS headers for this origin, under the same configured question. */
  private corsHeadersFor(origin: string | undefined): Record<string, string> {
    return this.cors.getCorsHeaders(origin, this.originOptions);
  }

  /**
   * A refusal the caller can read as JSON, carrying the CORS headers already
   * decided for its origin.
   *
   * The three refusals with a body — the two size bounds and the payload schema
   * — were the same construction written out. One place means the new refusal
   * cannot answer with different headers from the ones measured working beside
   * it, and a fourth cannot drift either.
   */
  private jsonRefusal(
    status: number,
    body: Record<string, unknown>,
    corsHeaders: Record<string, string>
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  private async handleRequest(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") ?? undefined;
    const clientIp = "127.0.0.1";

    // CORS preflight. A refused origin gets no `Access-Control-Allow-Origin`,
    // so the browser abandons the real request without it ever being sent.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: this.corsHeadersFor(origin) });
    }

    // CORS validation. An ABSENT origin lands here too: it is refused, because
    // a browser always sends one on a cross-origin POST (R4.1).
    if (!this.originAllowed(origin)) {
      this.logger.warn(`CORS rejected origin: ${origin}`);
      return new Response("Forbidden: Origin not allowed", { status: 403 });
    }

    const corsHeaders = this.corsHeadersFor(origin);

    // Rate limiting
    const rateLimitResult: RateLimitResult = this.rateLimiter.check(clientIp);
    if (!rateLimitResult.allowed) {
      this.logger.warn(`Rate limit exceeded for ${clientIp}`);
      return new Response("Too Many Requests", {
        status: 429,
        headers: { ...corsHeaders, "Retry-After": String(rateLimitResult.retryAfter) },
      });
    }

    if (req.method === "POST") {
      // Body size check
      const contentLength = Number(req.headers.get("content-length") ?? 0);
      if (contentLength > this.maxBodySize) {
        return this.jsonRefusal(
          413,
          { error: "Payload too large", limit: this.maxBodySize },
          corsHeaders
        );
      }

      let body: string;
      try {
        body = await req.text();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Read error";
        return new Response(message, { status: 400, headers: corsHeaders });
      }

      if (body.length > this.maxBodySize) {
        return this.jsonRefusal(
          413,
          { error: "Payload too large", limit: this.maxBodySize },
          corsHeaders
        );
      }

      this.logger.info(`Received callback: ${body.length} bytes`);

      // The body becomes a value only after it satisfies the payload schema
      // (R4.3). Order is the whole point: this returns BEFORE `this.resolve` is
      // read, so a refusal cannot spend the single-use window. The server keeps
      // listening and a legitimate reply still arrives — otherwise any
      // malformed POST would be a denial of service against the user's own
      // callback, which is a worse defect than the one being closed.
      const parsed = parseCallbackPayload(body);
      if (!parsed.ok) {
        this.logger.warn(`Callback body rejected — ${parsed.reason}`);
        return this.jsonRefusal(400, { error: "Invalid callback payload" }, corsHeaders);
      }

      // Resolve the promise and stop
      if (this.resolve) {
        const resolver = this.resolve;
        this.resolve = null;
        this.stop();
        // The validated payload as a value, and the same payload serialized —
        // not the bytes that arrived. Unknown keys were stripped by the schema,
        // so nothing the payload was not declared to carry rides onward into a
        // tool's output.
        resolver({
          ok: true,
          payload: parsed.payload,
          data: JSON.stringify(parsed.payload),
        });
      }

      return new Response("success", { status: 200, headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
}
