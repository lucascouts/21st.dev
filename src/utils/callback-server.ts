import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import net from "net";
import { CorsHandler } from "./cors-handler.js";
import { RateLimiter, RateLimitResult } from "./rate-limiter.js";
import { Logger } from "./logger.js";
import { SessionTokenManager } from "./session-token.js";

const logger = new Logger("CallbackServer");

// Default max body size: 1MB (Requirement A2.1)
const DEFAULT_MAX_BODY_SIZE = 1048576;

// Inactivity timeout: 5 minutes (Requirement B3.4)
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Server state for singleton pattern
 * Requirement B3.1-B3.4: Callback server reuse
 */
export enum ServerState {
  IDLE = "idle",
  BUSY = "busy",
  SHUTDOWN = "shutdown",
}

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
  // Singleton instance (Requirement B3.1)
  private static instance: CallbackServer | null = null;

  private server: Server | null = null;
  private port: number;
  private timeoutId?: NodeJS.Timeout;
  private promiseResolve?: (value: CallbackResponse) => void;
  private rateLimiter: RateLimiter;
  private sessionTokenManager: SessionTokenManager;
  private sessionToken: string | null = null;
  
  // Singleton state tracking (Requirement B3.2, B3.3)
  private state: ServerState = ServerState.SHUTDOWN;
  private inactivityTimer?: NodeJS.Timeout;
  private isSingletonInstance: boolean = false;

  constructor(port = 9221) {
    this.port = port;
    this.rateLimiter = new RateLimiter();
    this.sessionTokenManager = new SessionTokenManager();
  }

  /**
   * Get singleton instance of CallbackServer
   * Requirement B3.1: Support singleton mode for reuse
   * Requirement B3.2: Reuse existing server when idle
   * Requirement B3.3: Create new server when busy
   */
  static getInstance(port = 9221): CallbackServer {
    // If no instance exists, create new singleton
    if (!CallbackServer.instance) {
      logger.debug("Creating new singleton CallbackServer instance");
      CallbackServer.instance = new CallbackServer(port);
      CallbackServer.instance.isSingletonInstance = true;
      return CallbackServer.instance;
    }

    // If instance is busy, create a new temporary instance (Requirement B3.3)
    if (CallbackServer.instance.state === ServerState.BUSY) {
      logger.debug("Singleton is busy, creating temporary CallbackServer instance");
      const tempInstance = new CallbackServer(port);
      tempInstance.isSingletonInstance = false;
      return tempInstance;
    }

    // For IDLE or SHUTDOWN states, reuse the singleton (Requirement B3.2)
    // SHUTDOWN means the server hasn't been started yet or was shut down
    // IDLE means the server is running but not processing a callback
    logger.debug(`Reusing singleton CallbackServer instance (state: ${CallbackServer.instance.state})`);
    if (CallbackServer.instance.state === ServerState.IDLE) {
      CallbackServer.instance.resetInactivityTimer();
    }
    return CallbackServer.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    if (CallbackServer.instance) {
      CallbackServer.instance.shutdown();
      CallbackServer.instance = null;
    }
  }

  /**
   * Get current server state
   */
  getState(): ServerState {
    return this.state;
  }

  /**
   * Check if server is busy
   */
  isBusy(): boolean {
    return this.state === ServerState.BUSY;
  }

  /**
   * Reset inactivity timer
   * Requirement B3.4: Auto-shutdown after 5 minutes of inactivity
   */
  private resetInactivityTimer(): void {
    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }

    // Only set timer for singleton instances
    if (this.isSingletonInstance && this.state !== ServerState.SHUTDOWN) {
      this.inactivityTimer = setTimeout(() => {
        logger.info("Inactivity timeout reached, shutting down singleton server");
        this.shutdown();
      }, INACTIVITY_TIMEOUT_MS);
    }
  }

  /**
   * Stop inactivity timer
   */
  private stopInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
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
          this.sessionToken = null;
        }
        
        // For singleton, stay running but go idle; for temp instances, shutdown
        if (this.isSingletonInstance) {
          const resolver = this.promiseResolve;
          this.promiseResolve = undefined;
          this.state = ServerState.IDLE;
          this.resetInactivityTimer();
          resolver({ data: body });
        } else {
          this.promiseResolve({ data: body });
          this.shutdown();
        }
        
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
    this.state = ServerState.SHUTDOWN;
    
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
    // Stop inactivity timer
    this.stopInactivityTimer();
    
    // Clear singleton reference if this is the singleton instance
    if (this.isSingletonInstance && CallbackServer.instance === this) {
      CallbackServer.instance = null;
      logger.debug("Singleton CallbackServer instance cleared");
    }
  }

  // Start the server and return the port
  async start(): Promise<number> {
    // If server is already running and idle, just return the port (reuse)
    if (this.server && this.state === ServerState.IDLE) {
      logger.debug("Reusing existing server on port " + this.port);
      // Generate new session token for this callback
      this.sessionToken = this.sessionTokenManager.generate();
      this.resetInactivityTimer();
      return this.port;
    }
    
    this.port = await this.findAvailablePort(this.port);
    
    // Requirement A1.1: Generate cryptographically random token on session start
    this.sessionToken = this.sessionTokenManager.generate();
    logger.debug(`Generated session token for callback`);
    
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest);
      
      this.server.on("error", (error) => {
        logger.error("Server error:", error);
        this.state = ServerState.SHUTDOWN;
        reject(error);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        logger.info(`Listening on http://127.0.0.1:${this.port}/data`);
        this.state = ServerState.IDLE;
        this.resetInactivityTimer();
        resolve(this.port);
      });
    });
  }

  // Wait for callback after server is started
  async waitForCallback(timeout = 120000): Promise<CallbackResponse> {
    if (!this.server) {
      throw new Error("Server not started. Call start() first.");
    }

    // Set state to busy while waiting for callback (Requirement B3.3)
    this.state = ServerState.BUSY;
    this.stopInactivityTimer();

    return new Promise<CallbackResponse>((resolve) => {
      this.promiseResolve = (response: CallbackResponse) => {
        // Set state back to idle after callback completes
        if (this.isSingletonInstance && !response.timedOut) {
          this.state = ServerState.IDLE;
          this.resetInactivityTimer();
        }
        resolve(response);
      };

      this.timeoutId = setTimeout(() => {
        logger.info("Timeout reached");
        // For singleton, go back to idle on timeout; for temp instances, shutdown
        if (this.isSingletonInstance) {
          this.state = ServerState.IDLE;
          this.resetInactivityTimer();
          if (this.promiseResolve) {
            this.promiseResolve({ timedOut: true });
          }
        } else {
          if (this.promiseResolve) {
            this.promiseResolve({ timedOut: true });
          }
          this.shutdown();
        }
      }, timeout);
    });
  }

  cancel(): void {
    if (this.promiseResolve) {
      this.promiseResolve({ timedOut: true });
    }
    // For singleton, go back to idle; for temp instances, shutdown
    if (this.isSingletonInstance) {
      this.state = ServerState.IDLE;
      this.resetInactivityTimer();
      // Clear the timeout and promise resolver
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = undefined;
      }
      this.promiseResolve = undefined;
    } else {
      this.shutdown();
    }
  }
}
