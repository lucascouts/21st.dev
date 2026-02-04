import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import net from "net";
import { CorsHandler } from "./cors-handler.js";
import { RateLimiter, RateLimitResult } from "./rate-limiter.js";
import { Logger } from "./logger.js";

const logger = new Logger("CallbackServer");

export interface CallbackResponse {
  data?: string;
  timedOut?: boolean;
}

export class CallbackServer {
  private server: Server | null = null;
  private port: number;
  private timeoutId?: NodeJS.Timeout;
  private promiseResolve?: (value: CallbackResponse) => void;
  private rateLimiter: RateLimiter;

  constructor(port = 9221) {
    this.port = port;
    this.rateLimiter = new RateLimiter();
  }

  getPort(): number {
    return this.port;
  }

  private async findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`);
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net
        .createServer()
        .once("error", () => resolve(false))
        .once("listening", () => {
          tester.close();
          resolve(true);
        })
        .listen(port, "127.0.0.1");
    });
  }

  private parseBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => resolve(body));
    });
  }

  /**
   * Extract client IP from request
   * Handles X-Forwarded-For header and falls back to socket address
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(",")[0].trim();
    }
    return req.socket.remoteAddress || "unknown";
  }

  private handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin as string | undefined;
    const clientIp = this.getClientIp(req);

    // CORS validation (Requirements 5.1, 5.2, 5.3, 5.4)
    if (!CorsHandler.isAllowedOrigin(origin)) {
      logger.warn(`CORS rejected origin: ${origin} from IP: ${clientIp}`);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: Origin not allowed");
      return;
    }

    // Set CORS headers for allowed origins
    const corsHeaders = CorsHandler.getCorsHeaders(origin);
    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value as string);
    }

    // Handle OPTIONS preflight request
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Rate limiting (Requirements 6.1, 6.2, 6.3, 6.4)
    const rateLimitResult: RateLimitResult = this.rateLimiter.check(clientIp);
    if (!rateLimitResult.allowed) {
      logger.warn(`Rate limit exceeded for IP: ${clientIp}, retry after: ${rateLimitResult.retryAfter}s`);
      res.writeHead(429, {
        "Content-Type": "text/plain",
        "Retry-After": String(rateLimitResult.retryAfter),
      });
      res.end("Too Many Requests");
      return;
    }

    if (req.method === "POST" && req.url === "/data") {
      const body = await this.parseBody(req);
      logger.info(`Received POST /data with ${body.length} bytes from IP: ${clientIp}`);
      
      if (this.promiseResolve) {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.promiseResolve({ data: body });
        this.shutdown();
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server not ready");
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  };

  private shutdown(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    // Stop rate limiter cleanup interval
    this.rateLimiter.stopCleanup();
  }

  // Start the server and return the port
  async start(): Promise<number> {
    this.port = await this.findAvailablePort(this.port);
    
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest);
      
      this.server.on("error", (error) => {
        logger.error("Server error:", error);
        reject(error);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        logger.info(`Listening on http://127.0.0.1:${this.port}/data`);
        resolve(this.port);
      });
    });
  }

  // Wait for callback after server is started
  async waitForCallback(timeout = 120000): Promise<CallbackResponse> {
    if (!this.server) {
      throw new Error("Server not started. Call start() first.");
    }

    return new Promise<CallbackResponse>((resolve) => {
      this.promiseResolve = resolve;

      this.timeoutId = setTimeout(() => {
        logger.info("Timeout reached");
        resolve({ timedOut: true });
        this.shutdown();
      }, timeout);
    });
  }

  cancel(): void {
    if (this.promiseResolve) {
      this.promiseResolve({ timedOut: true });
    }
    this.shutdown();
  }
}
