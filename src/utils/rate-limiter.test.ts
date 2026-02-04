import * as fc from "fast-check";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  /**
   * Property 9: Rate Limit Enforcement
   * For any IP address that has made more than 10 requests within a 60-second
   * window, the Rate_Limiter SHALL reject subsequent requests with 429 Too Many
   * Requests until the window resets.
   *
   * **Validates: Requirements 6.1, 6.2**
   */
  describe("Property 9: Rate Limit Enforcement", () => {
    it("should allow requests up to the limit and reject after", () => {
      fc.assert(
        fc.property(
          // Generate IP addresses
          fc.tuple(
            fc.integer({ min: 1, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 1, max: 255 })
          ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
          // Generate max requests between 1 and 20
          fc.integer({ min: 1, max: 20 }),
          (ip, maxRequests) => {
            const limiter = new RateLimiter({
              maxRequests,
              windowMs: 60000,
            });

            // Stop cleanup to avoid interference
            limiter.stopCleanup();

            try {
              // Make exactly maxRequests requests - all should be allowed
              for (let i = 0; i < maxRequests; i++) {
                const result = limiter.check(ip);
                if (!result.allowed) {
                  return false; // Should be allowed
                }
              }

              // The next request should be rejected
              const rejectedResult = limiter.check(ip);
              if (rejectedResult.allowed) {
                return false; // Should be rejected
              }

              // Verify retryAfter is present and positive
              if (
                rejectedResult.retryAfter === undefined ||
                rejectedResult.retryAfter <= 0
              ) {
                return false;
              }

              // Verify remaining is 0
              if (rejectedResult.remaining !== 0) {
                return false;
              }

              return true;
            } finally {
              limiter.stopCleanup();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should track requests independently per IP address", () => {
      fc.assert(
        fc.property(
          // Generate two different IP addresses
          fc.tuple(
            fc.integer({ min: 1, max: 127 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 1, max: 255 })
          ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
          fc.tuple(
            fc.integer({ min: 128, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 1, max: 255 })
          ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
          (ip1, ip2) => {
            const limiter = new RateLimiter({
              maxRequests: 5,
              windowMs: 60000,
            });

            limiter.stopCleanup();

            try {
              // Exhaust limit for ip1
              for (let i = 0; i < 5; i++) {
                limiter.check(ip1);
              }

              // ip1 should be rate limited
              const ip1Result = limiter.check(ip1);
              if (ip1Result.allowed) {
                return false;
              }

              // ip2 should still be allowed (independent tracking)
              const ip2Result = limiter.check(ip2);
              if (!ip2Result.allowed) {
                return false;
              }

              return true;
            } finally {
              limiter.stopCleanup();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should return correct remaining count", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 15 }),
          fc.integer({ min: 1, max: 4 }),
          (maxRequests, requestCount) => {
            const limiter = new RateLimiter({
              maxRequests,
              windowMs: 60000,
            });

            limiter.stopCleanup();

            try {
              const ip = "192.168.1.1";

              // Make requestCount requests
              for (let i = 0; i < requestCount; i++) {
                limiter.check(ip);
              }

              // Check remaining after requestCount requests
              const result = limiter.check(ip);
              const expectedRemaining = maxRequests - requestCount - 1;

              return result.remaining === expectedRemaining;
            } finally {
              limiter.stopCleanup();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should provide valid resetTime in the future", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "127.0.0.1"
          ),
          (ip) => {
            const limiter = new RateLimiter({
              maxRequests: 10,
              windowMs: 60000,
            });

            limiter.stopCleanup();

            try {
              const beforeCheck = Date.now();
              const result = limiter.check(ip);
              const afterCheck = Date.now();

              // resetTime should be >= beforeCheck (could be equal due to timing)
              // and within the window from when the check was made
              return (
                result.resetTime >= beforeCheck &&
                result.resetTime <= afterCheck + 60000
              );
            } finally {
              limiter.stopCleanup();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Unit Tests", () => {
    it("should reset rate limit for an IP", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60000 });
      limiter.stopCleanup();

      const ip = "192.168.1.100";

      // Exhaust the limit
      limiter.check(ip);
      limiter.check(ip);
      expect(limiter.check(ip).allowed).toBe(false);

      // Reset and verify requests are allowed again
      limiter.reset(ip);
      expect(limiter.check(ip).allowed).toBe(true);

      limiter.stopCleanup();
    });

    it("should cleanup expired entries", () => {
      const limiter = new RateLimiter({ maxRequests: 10, windowMs: 100 });
      limiter.stopCleanup();

      // Make some requests
      limiter.check("192.168.1.1");
      limiter.check("192.168.1.2");
      expect(limiter.getEntryCount()).toBe(2);

      // Wait for window to expire and cleanup
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          limiter.cleanup();
          expect(limiter.getEntryCount()).toBe(0);
          limiter.stopCleanup();
          resolve();
        }, 150);
      });
    });

    it("should use default values when no options provided", () => {
      const limiter = new RateLimiter();
      limiter.stopCleanup();

      const ip = "10.0.0.1";

      // Should allow 10 requests (default)
      for (let i = 0; i < 10; i++) {
        expect(limiter.check(ip).allowed).toBe(true);
      }

      // 11th request should be rejected
      expect(limiter.check(ip).allowed).toBe(false);

      limiter.stopCleanup();
    });
  });
});
