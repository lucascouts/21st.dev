import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import net from "net";
import { CorsHandler } from "./cors-handler.js";
import { RateLimiter, RateLimitResult } from "./rate-limiter.js";
import { Logger } from "./logger.js";
import { SessionTokenManager } from "./session-token.js";

const logger = new Logger("CallbackServer");

// Default max body size: 1MB (Requirement A2.1)
const DEFAULT_MAX_BODY_SIZE = 1048576;

/**
 * Get the maximum body size from environment variable or use default
 * Requirement A2.2: Support MAX_BODY_SIZE env variable
 */
export function getMaxBodySize(): number {
  const envValue = process.env.MAX_BODY_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    logger.warn(`Invalid MAX_BODY_SIZE value: ${envValue}, using default: ${DEFAULT_MAX_BODY_SIZE}`);
  }
  return DEFAULT_MAX_BODY_SIZE;
}

/**
 * Custom error for body size limit exceeded
 */
export class BodyTooLargeError extends Error {
  public readonly limit: number;
  public readonly received: number;

  constructor(limit: number, received: number) {
    super(`Payload too large: received ${received} bytes, limit is ${limit} bytes`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
    this.received = received;
  }
}

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
  private sessionTokenManager: SessionTokenManager;
  private sessionToken: string | null = null;

  constructor(port = 9221) {
    this.port = port;
    this.rateLimiter = new RateLimiter();
    this.sessionTokenManager = new SessionTokenManager();
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Get the session token for this callback session
   * Used by tools to include token in callback URL
   * Requirement A1.2: Token included as query parameter
   */
  getSessionToken(): string | null {
    return this.sessionToken;
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

  /**
   * Parse request body with size limit enforcement
   * Requirements A2.1-A2.4: Body size limiting
   */
  private parseBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const maxBodySize = getMaxBodySize();
      let body = "";
      let currentSize = 0;

      req.on("data", (chunk: Buffer) => {
        currentSize += chunk.length;
        
        // Requirement A2.4: Abort reading once limit exceeded
        if (currentSize > maxBodySize) {
          req.destroy();
          reject(new BodyTooLargeError(maxBodySize, currentSize));
          return;
        }
        
        body += chunk.toString();
      });

      req.on("error", (err) => {
        // Handle stream errors (including destroy)
        if (!(err instanceof BodyTooLargeError)) {
          reject(err);
        }
      });

      req.on("end", () => resolve(body));
    });
  }

  /**
   * Extract token from URL query parameters
   * Requirement A1.3: Validate token on POST /data
   */
  private extractTokenFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    try {
      const urlObj = new URL(url, "http://localhost");
      return urlObj.searchParams.get("token");
    } catch {
      return null;
    }
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

    if (req.method === "POST" && req.url?.startsWith("/data")) {
      // Requirement A1.3, A1.4: Validate session token
      const token = this.extractTokenFromUrl(req.url);
      
      if (!token) {
        logger.warn(`Missing session token from IP: ${clientIp}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing session token" }));
        return;
      }
      
      if (!this.sessionTokenManager.validate(token)) {
        // Check if token was ever valid (expired vs invalid)
        const tokenInfo = this.sessionTokenManager.getTokenInfo(token);
        if (tokenInfo && Date.now() > tokenInfo.expiresAt) {
          logger.warn(`Expired session token from IP: ${clientIp}`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session token expired" }));
        } else {
          logger.warn(`Invalid session token from IP: ${clientIp}`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid session token" }));
        }
        return;
      }
      
      let body: string;
      try {
        body = await this.parseBody(req);
      } catch (err) {
        // Requirement A2.3: Return 413 Payload Too Large
        if (err instanceof BodyTooLargeError) {
          logger.warn(`Body size limit exceeded from IP: ${clientIp}, limit: ${err.limit}, received: ${err.received}`);
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large", limit: err.limit }));
          return;
        }
        // Re-throw other errors
        throw err;
      }
      
      logger.info(`Received POST /data with ${body.length} bytes from IP: ${clientIp}`);
      
      if (this.promiseResolve) {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        // Requirement A1.5: Invalidate token after successful use
        if (this.sessionToken) {
          this.sessionTokenManager.invalidate(this.sessionToken);
        }
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
    // Requirement A1.5: Invalidate token on session end
    if (this.sessionToken) {
      this.sessionTokenManager.invalidate(this.sessionToken);
      this.sessionToken = null;
    }
    // Stop rate limiter cleanup interval
    this.rateLimiter.stopCleanup();
    // Stop session token manager cleanup interval
    this.sessionTokenManager.stopCleanup();
  }

  // Start the server and return the port
  async start(): Promise<number> {
    this.port = await this.findAvailablePort(this.port);
    
    // Requirement A1.1: Generate cryptographically random token on session start
    this.sessionToken = this.sessionTokenManager.generate();
    logger.debug(`Generated session token for callback`);
    
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
