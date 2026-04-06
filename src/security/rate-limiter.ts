export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly entries: Map<string, RateLimitEntry>;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.maxRequests = options?.maxRequests ?? 10;
    this.windowMs = options?.windowMs ?? 60000;
    this.entries = new Map();
    this.startCleanup();
  }

  check(ip: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.entries.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(ip, entry);
    }

    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    const currentCount = entry.timestamps.length;
    const remaining = Math.max(0, this.maxRequests - currentCount);
    const oldestTimestamp = entry.timestamps[0];
    const resetTime = oldestTimestamp
      ? oldestTimestamp + this.windowMs
      : now + this.windowMs;

    if (currentCount >= this.maxRequests) {
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    entry.timestamps.push(now);
    return {
      allowed: true,
      remaining: remaining - 1,
      resetTime,
    };
  }

  reset(ip: string): void {
    this.entries.delete(ip);
  }

  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [ip, entry] of this.entries) {
      entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
      if (entry.timestamps.length === 0) {
        this.entries.delete(ip);
      }
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  getEntryCount(): number {
    return this.entries.size;
  }
}
