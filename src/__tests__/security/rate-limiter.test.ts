import { describe, it, expect, afterEach } from "bun:test";
import { RateLimiter } from "../../security/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    if (limiter) {
      limiter.stopCleanup();
    }
  });

  it("allows up to maxRequests then rejects", () => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60000 });

    const r1 = limiter.check("127.0.0.1");
    expect(r1.allowed).toBe(true);

    const r2 = limiter.check("127.0.0.1");
    expect(r2.allowed).toBe(true);

    const r3 = limiter.check("127.0.0.1");
    expect(r3.allowed).toBe(true);

    const r4 = limiter.check("127.0.0.1");
    expect(r4.allowed).toBe(false);
  });

  it("returns correct remaining count", () => {
    limiter = new RateLimiter({ maxRequests: 5, windowMs: 60000 });

    const r1 = limiter.check("127.0.0.1");
    expect(r1.remaining).toBe(4);

    const r2 = limiter.check("127.0.0.1");
    expect(r2.remaining).toBe(3);
  });

  it("stopCleanup() clears the cleanup interval", () => {
    limiter = new RateLimiter({ maxRequests: 10, windowMs: 60000 });
    // Should not throw
    limiter.stopCleanup();
    // Calling again should also be safe
    limiter.stopCleanup();
  });

  it("tracks different IPs independently", () => {
    limiter = new RateLimiter({ maxRequests: 1, windowMs: 60000 });

    const r1 = limiter.check("10.0.0.1");
    expect(r1.allowed).toBe(true);

    const r2 = limiter.check("10.0.0.2");
    expect(r2.allowed).toBe(true);

    const r3 = limiter.check("10.0.0.1");
    expect(r3.allowed).toBe(false);
  });
});
