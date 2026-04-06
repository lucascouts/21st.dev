import type { CorsHandler } from "./cors.js";
import type { RateLimiter, RateLimitResult } from "../security/rate-limiter.js";
import type { Logger } from "../logger.js";

export interface CallbackServerConfig {
  maxBodySize: number;
  cors: typeof CorsHandler;
  rateLimiter: RateLimiter;
  logger: Logger;
}

export type CallbackResult =
  | { ok: true; data: string }
  | { ok: false; reason: "timeout" | "cancelled" | "error"; message?: string };

export class CallbackServer {
  private readonly maxBodySize: number;
  private readonly cors: typeof CorsHandler;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private resolve: ((result: CallbackResult) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CallbackServerConfig) {
    this.maxBodySize = config.maxBodySize;
    this.cors = config.cors;
    this.rateLimiter = config.rateLimiter;
    this.logger = config.logger;
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

  private async handleRequest(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") ?? undefined;
    const clientIp = "127.0.0.1";

    // CORS preflight
    if (req.method === "OPTIONS") {
      const corsHeaders = this.cors.getCorsHeaders(origin);
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // CORS validation
    if (!this.cors.isAllowedOrigin(origin)) {
      this.logger.warn(`CORS rejected origin: ${origin}`);
      return new Response("Forbidden: Origin not allowed", { status: 403 });
    }

    const corsHeaders = this.cors.getCorsHeaders(origin);

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
        return new Response(
          JSON.stringify({ error: "Payload too large", limit: this.maxBodySize }),
          { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
        return new Response(
          JSON.stringify({ error: "Payload too large", limit: this.maxBodySize }),
          { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      this.logger.info(`Received callback: ${body.length} bytes`);

      // Resolve the promise and stop
      if (this.resolve) {
        const resolver = this.resolve;
        this.resolve = null;
        this.stop();
        resolver({ ok: true, data: body });
      }

      return new Response("success", { status: 200, headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
}
