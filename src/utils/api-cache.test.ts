import * as fc from "fast-check";
import { ApiCache } from "./api-cache.js";

describe("api-cache", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("basic functionality", () => {
    it("should store and retrieve values", () => {
      const cache = new ApiCache<string>();
      cache.set("key1", "value1");
      expect(cache.get("key1")).toBe("value1");
    });

    it("should return null for non-existent keys", () => {
      const cache = new ApiCache<string>();
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("should track cache size", () => {
      const cache = new ApiCache<string>();
      expect(cache.size).toBe(0);
      cache.set("key1", "value1");
      expect(cache.size).toBe(1);
      cache.set("key2", "value2");
      expect(cache.size).toBe(2);
    });

    it("should clear all entries", () => {
      const cache = new ApiCache<string>();
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("key1")).toBeNull();
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entry when at capacity", () => {
      const cache = new ApiCache<string>({ maxEntries: 3 });
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");
      cache.set("key4", "value4"); // Should evict key1

      expect(cache.get("key1")).toBeNull();
      expect(cache.get("key2")).toBe("value2");
      expect(cache.get("key3")).toBe("value3");
      expect(cache.get("key4")).toBe("value4");
    });

    it("should update LRU order on access", () => {
      const cache = new ApiCache<string>({ maxEntries: 3 });
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");
      
      // Access key1 to make it most recently used
      cache.get("key1");
      
      // Add new entry, should evict key2 (now oldest)
      cache.set("key4", "value4");

      expect(cache.get("key1")).toBe("value1");
      expect(cache.get("key2")).toBeNull();
      expect(cache.get("key3")).toBe("value3");
      expect(cache.get("key4")).toBe("value4");
    });
  });

  describe("TTL expiration", () => {
    it("should expire entries after TTL", async () => {
      const cache = new ApiCache<string>({ defaultTtl: 1 }); // 1 second TTL
      cache.set("key1", "value1");
      
      expect(cache.get("key1")).toBe("value1");
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      expect(cache.get("key1")).toBeNull();
    });

    it("should use custom TTL when provided", async () => {
      const cache = new ApiCache<string>({ defaultTtl: 10 });
      cache.set("key1", "value1", 1); // 1 second custom TTL
      
      expect(cache.get("key1")).toBe("value1");
      
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      expect(cache.get("key1")).toBeNull();
    });

    it("should use CACHE_TTL environment variable", () => {
      process.env.CACHE_TTL = "600";
      const cache = new ApiCache<string>();
      cache.set("key1", "value1");
      
      // Entry should exist (TTL is 600 seconds)
      expect(cache.get("key1")).toBe("value1");
    });
  });

  describe("generateKey", () => {
    it("should return URL for GET requests (no body)", () => {
      const key = ApiCache.generateKey("/api/test");
      expect(key).toBe("/api/test");
    });

    it("should include body hash for POST requests", () => {
      const key1 = ApiCache.generateKey("/api/test", { data: "value1" });
      const key2 = ApiCache.generateKey("/api/test", { data: "value2" });
      
      expect(key1).not.toBe("/api/test");
      expect(key2).not.toBe("/api/test");
      expect(key1).not.toBe(key2);
    });

    it("should produce consistent keys for same input", () => {
      const body = { data: "test", nested: { value: 123 } };
      const key1 = ApiCache.generateKey("/api/test", body);
      const key2 = ApiCache.generateKey("/api/test", body);
      
      expect(key1).toBe(key2);
    });
  });

  describe("getStats", () => {
    it("should track hits and misses", () => {
      const cache = new ApiCache<string>();
      cache.set("key1", "value1");
      
      cache.get("key1"); // hit
      cache.get("key1"); // hit
      cache.get("nonexistent"); // miss
      
      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
    });

    it("should reset stats on clear", () => {
      const cache = new ApiCache<string>();
      cache.set("key1", "value1");
      cache.get("key1");
      cache.get("nonexistent");
      cache.clear();
      
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
    });
  });

  /**
   * Property B1: Cache Hit Determinism
   * For any two identical GET requests within the TTL window, the second
   * request SHALL return the cached response without making a network call.
   *
   * **Validates: Requirement B1.2**
   */
  describe("Property B1: Cache Hit Determinism", () => {
    it("should return same data for identical keys within TTL", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.jsonValue(),
          (key, value) => {
            const cache = new ApiCache<unknown>({ defaultTtl: 300 });
            cache.set(key, value);
            
            const result1 = cache.get(key);
            const result2 = cache.get(key);
            
            // Both retrievals should return the exact same value
            return (
              JSON.stringify(result1) === JSON.stringify(value) &&
              JSON.stringify(result2) === JSON.stringify(value)
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should increment hits for repeated access to same key", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.integer({ min: 2, max: 10 }),
          (key, accessCount) => {
            const cache = new ApiCache<string>({ defaultTtl: 300 });
            cache.set(key, "value");
            
            for (let i = 0; i < accessCount; i++) {
              cache.get(key);
            }
            
            const stats = cache.getStats();
            return stats.hits === accessCount;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property B2: Cache Miss on POST
   * For any POST request, the cache SHALL NOT be consulted and a fresh
   * network request SHALL be made.
   *
   * Note: This property is enforced at the HTTP client level. Here we test
   * that generateKey produces unique keys for different bodies, ensuring
   * POST requests with different payloads don't collide.
   *
   * **Validates: Requirement B1.4**
   */
  describe("Property B2: Cache Key Uniqueness for Different Bodies", () => {
    it("should generate different keys for different request bodies", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.jsonValue(),
          fc.jsonValue(),
          (url, body1, body2) => {
            // Skip if bodies are identical
            if (JSON.stringify(body1) === JSON.stringify(body2)) {
              return true;
            }
            
            const key1 = ApiCache.generateKey(url, body1);
            const key2 = ApiCache.generateKey(url, body2);
            
            // Different bodies should produce different keys
            return key1 !== key2;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should generate same key for same URL without body", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (url) => {
            const key1 = ApiCache.generateKey(url);
            const key2 = ApiCache.generateKey(url);
            const key3 = ApiCache.generateKey(url, null);
            const key4 = ApiCache.generateKey(url, undefined);
            
            // All should be identical (GET request pattern)
            return key1 === key2 && key2 === key3 && key3 === key4;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("LRU Property Tests", () => {
    it("should maintain maxEntries limit", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.string()), { minLength: 1, maxLength: 100 }),
          (maxEntries, entries) => {
            const cache = new ApiCache<string>({ maxEntries });
            
            for (const [key, value] of entries) {
              cache.set(key, value);
            }
            
            // Cache size should never exceed maxEntries
            return cache.size <= maxEntries;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
