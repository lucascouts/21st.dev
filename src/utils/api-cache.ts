/**
 * API Cache - LRU cache for API responses
 * Requirements: B1.1-B1.5
 */

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface CacheOptions {
  maxEntries?: number;  // default: 100
  defaultTtl?: number;  // default: 300 (5 min)
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/**
 * Get TTL from environment variable or use default
 * Requirements: B1.3
 */
function getTtlFromEnv(): number {
  const envTtl = process.env.CACHE_TTL;
  if (envTtl) {
    const parsed = parseInt(envTtl, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 300; // Default 5 minutes
}

/**
 * Simple hash function for generating cache keys
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

/**
 * LRU Cache implementation for API responses
 * Requirements: B1.1, B1.2, B1.3
 */
export class ApiCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxEntries: number;
  private defaultTtl: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(options?: CacheOptions) {
    this.cache = new Map();
    this.maxEntries = options?.maxEntries ?? 100;
    this.defaultTtl = options?.defaultTtl ?? getTtlFromEnv();
  }

  /**
   * Get cached value if exists and not expired
   * Requirements: B1.2
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL expiration
    const now = Date.now();
    const expiresAt = entry.timestamp + (entry.ttl * 1000);
    
    if (now > expiresAt) {
      // Entry expired, remove it
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end for LRU (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    this.hits++;
    return entry.data;
  }

  /**
   * Set value with optional custom TTL
   * Requirements: B1.1, B1.3
   */
  set(key: string, value: T, ttl?: number): void {
    // LRU eviction: remove oldest entry if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    // If key exists, delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    const entry: CacheEntry<T> = {
      data: value,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    };

    this.cache.set(key, entry);
  }

  /**
   * Generate cache key from URL and optional body
   * Requirements: B1.5
   */
  static generateKey(url: string, body?: unknown): string {
    if (body === undefined || body === null) {
      return url;
    }
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return `${url}:${simpleHash(bodyStr)}`;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    };
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    const now = Date.now();
    const expiresAt = entry.timestamp + (entry.ttl * 1000);
    
    if (now > expiresAt) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get current size
   */
  get size(): number {
    return this.cache.size;
  }
}

// Export singleton instance for HTTP client integration
export const apiCache = new ApiCache<unknown>();
