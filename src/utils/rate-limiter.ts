/**
 * Rate Limiter - Implements sliding window rate limiting
 * Implements security rules per Requirements 6.1, 6.2, 6.3, 6.4
 */

export interface RateLimiterOptions {
  /** Maximum requests per window (default: 10) */
  maxRequests: number;
  /** Window size in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of requests remaining in current window */
  remaining: number;
  /** Unix timestamp (ms) when the limit resets */
  resetTime: number;
  /** Seconds to wait if rate limited (only present when not allowed) */
  retryAfter?: number;
}

interface RateLimitEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
}

/**
 * Rate Limiter class using sliding window algorithm
 * Limits requests per IP address to prevent abuse
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly entries: Map<string, RateLimitEntry>;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.maxRequests = options?.maxRequests ?? 10;
    this.windowMs = options?.windowMs ?? 60000;
    this.entries = new Map();

    // Start automatic cleanup every minute
    this.startCleanup();
  }

  /**
   * Check if a request from an IP is allowed
   * @param ip - Client IP address
   * @returns Rate limit result with allowed status and metadata
   */
  check(ip: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get or create entry for this IP
    let entry = this.entries.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(ip, entry);
    }

    // Remove timestamps outside the current window (sliding window)
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    // Calculate remaining requests
    const currentCount = entry.timestamps.length;
    const remaining = Math.max(0, this.maxRequests - currentCount);

    // Calculate reset time (when the oldest request in window expires)
    const oldestTimestamp = entry.timestamps[0];
    const resetTime = oldestTimestamp 
      ? oldestTimestamp + this.windowMs 
      : now + this.windowMs;

    // Check if request is allowed
    if (currentCount >= this.maxRequests) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Request allowed - record this request
    entry.timestamps.push(now);

    return {
      allowed: true,
      remaining: remaining - 1, // Subtract 1 for the current request
      resetTime,
    };
  }

  /**
   * Reset rate limit for an IP (useful for testing)
   * @param ip - Client IP address to reset
   */
  reset(ip: string): void {
    this.entries.delete(ip);
  }

  /**
   * Clean up expired entries to prevent memory leaks
   * Removes entries with no requests in the current window
   */
  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [ip, entry] of this.entries) {
      // Filter out expired timestamps
      entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

      // Remove entry if no timestamps remain
      if (entry.timestamps.length === 0) {
        this.entries.delete(ip);
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
   * Get current entry count (for testing/monitoring)
   */
  getEntryCount(): number {
    return this.entries.size;
  }
}
