/**
 * Session Token Manager - Cryptographic session token generation and validation
 * Implements security requirements A1.1-A1.5 for CSRF and replay attack prevention
 *
 * Requirements: A1.1, A1.2, A1.3, A1.4, A1.5
 */

import { randomBytes } from "node:crypto";

export interface SessionToken {
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionTokenOptions {
  /** Token expiration time in milliseconds (default: 300000 = 5 minutes) */
  expirationMs?: number;
}

const DEFAULT_EXPIRATION_MS = 300000; // 5 minutes

/**
 * Session Token Manager class
 * Generates, validates, and manages cryptographic session tokens
 */
export class SessionTokenManager {
  private activeTokens: Map<string, SessionToken>;
  private readonly expirationMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: SessionTokenOptions) {
    this.activeTokens = new Map();
    this.expirationMs = options?.expirationMs ?? DEFAULT_EXPIRATION_MS;
    this.startCleanup();
  }

  /**
   * Generate a new session token
   * Uses crypto.randomBytes(32) for 256-bit cryptographic randomness
   * @returns 64-character hex-encoded token
   *
   * Requirement A1.1: Generate cryptographically random token (32 bytes)
   */
  generate(): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();

    const sessionToken: SessionToken = {
      token,
      createdAt: now,
      expiresAt: now + this.expirationMs,
    };

    this.activeTokens.set(token, sessionToken);
    return token;
  }

  /**
   * Validate a token
   * @param token - Token to validate
   * @returns true if token is valid and not expired
   *
   * Requirements A1.3, A1.4: Validate token matches session, reject if invalid
   */
  validate(token: string): boolean {
    if (!token) {
      return false;
    }

    const sessionToken = this.activeTokens.get(token);
    if (!sessionToken) {
      return false;
    }

    // Check expiration
    if (Date.now() > sessionToken.expiresAt) {
      this.activeTokens.delete(token);
      return false;
    }

    return true;
  }

  /**
   * Invalidate a token (after use or timeout)
   * @param token - Token to invalidate
   *
   * Requirement A1.5: Invalidate token when session completes or times out
   */
  invalidate(token: string): void {
    this.activeTokens.delete(token);
  }

  /**
   * Clean up expired tokens
   * Removes all tokens that have exceeded their expiration time
   */
  cleanup(): void {
    const now = Date.now();
    for (const [token, sessionToken] of this.activeTokens) {
      if (now > sessionToken.expiresAt) {
        this.activeTokens.delete(token);
      }
    }
  }

  /**
   * Start automatic cleanup interval
   */
  private startCleanup(): void {
    // Clean up every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    // Ensure the interval doesn't prevent process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop the cleanup interval (for testing/shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get active token count (for testing/monitoring)
   */
  getActiveTokenCount(): number {
    return this.activeTokens.size;
  }

  /**
   * Get token info (for testing)
   */
  getTokenInfo(token: string): SessionToken | undefined {
    return this.activeTokens.get(token);
  }
}
