import * as fc from "fast-check";
import { SessionTokenManager } from "./session-token.js";

describe("SessionTokenManager", () => {
  /**
   * Property A1: Session Token Uniqueness
   * For any two session tokens generated within the same process,
   * the tokens SHALL be different with probability > 1 - 2^-128.
   *
   * **Validates: Requirement A1.1**
   */
  describe("Property A1: Session Token Uniqueness", () => {
    it("should generate unique tokens across multiple generations", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 100 }),
          (tokenCount) => {
            const manager = new SessionTokenManager();
            manager.stopCleanup();

            try {
              const tokens = new Set<string>();

              for (let i = 0; i < tokenCount; i++) {
                const token = manager.generate();
                if (tokens.has(token)) {
                  return false; // Collision detected
                }
                tokens.add(token);
              }

              return tokens.size === tokenCount;
            } finally {
              manager.stopCleanup();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should generate 64-character hex tokens", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (iterations) => {
            const manager = new SessionTokenManager();
            manager.stopCleanup();

            try {
              for (let i = 0; i < iterations; i++) {
                const token = manager.generate();
                // 32 bytes = 64 hex characters
                if (token.length !== 64) {
                  return false;
                }
                // Should only contain hex characters
                if (!/^[0-9a-f]+$/.test(token)) {
                  return false;
                }
              }
              return true;
            } finally {
              manager.stopCleanup();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property A2: Token Validation Strictness
   * For any request to POST /data, IF the token parameter does not exactly
   * match an active session token, THEN the request SHALL be rejected with 401.
   *
   * **Validates: Requirements A1.3, A1.4**
   */
  describe("Property A2: Token Validation Strictness", () => {
    it("should validate only exact token matches", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (randomString) => {
            const manager = new SessionTokenManager();
            manager.stopCleanup();

            try {
              const validToken = manager.generate();

              // Valid token should pass
              if (!manager.validate(validToken)) {
                return false;
              }

              // Random string should fail (unless it happens to match)
              if (randomString !== validToken && manager.validate(randomString)) {
                return false;
              }

              return true;
            } finally {
              manager.stopCleanup();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject empty and null-like tokens", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      try {
        expect(manager.validate("")).toBe(false);
        expect(manager.validate(null as unknown as string)).toBe(false);
        expect(manager.validate(undefined as unknown as string)).toBe(false);
      } finally {
        manager.stopCleanup();
      }
    });
  });

  describe("Unit Tests - Token Generation (Requirement A1.1)", () => {
    it("should generate a 64-character hex token", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      const token = manager.generate();

      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]+$/);

      manager.stopCleanup();
    });

    it("should store token with creation and expiration times", () => {
      const manager = new SessionTokenManager({ expirationMs: 60000 });
      manager.stopCleanup();

      const beforeGenerate = Date.now();
      const token = manager.generate();
      const afterGenerate = Date.now();

      const tokenInfo = manager.getTokenInfo(token);

      expect(tokenInfo).toBeDefined();
      expect(tokenInfo!.createdAt).toBeGreaterThanOrEqual(beforeGenerate);
      expect(tokenInfo!.createdAt).toBeLessThanOrEqual(afterGenerate);
      expect(tokenInfo!.expiresAt).toBe(tokenInfo!.createdAt + 60000);

      manager.stopCleanup();
    });
  });

  describe("Unit Tests - Token Validation (Requirements A1.3, A1.4)", () => {
    it("should validate a valid token", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      const token = manager.generate();
      expect(manager.validate(token)).toBe(true);

      manager.stopCleanup();
    });

    it("should reject an invalid token", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      expect(manager.validate("invalid-token")).toBe(false);

      manager.stopCleanup();
    });

    it("should reject an expired token", async () => {
      const manager = new SessionTokenManager({ expirationMs: 50 });
      manager.stopCleanup();

      const token = manager.generate();
      expect(manager.validate(token)).toBe(true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(manager.validate(token)).toBe(false);

      manager.stopCleanup();
    });
  });

  describe("Unit Tests - Token Invalidation (Requirement A1.5)", () => {
    it("should invalidate a token", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      const token = manager.generate();
      expect(manager.validate(token)).toBe(true);

      manager.invalidate(token);
      expect(manager.validate(token)).toBe(false);

      manager.stopCleanup();
    });

    it("should handle invalidating non-existent token gracefully", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      expect(() => manager.invalidate("non-existent")).not.toThrow();

      manager.stopCleanup();
    });
  });

  describe("Unit Tests - Cleanup", () => {
    it("should cleanup expired tokens", async () => {
      const manager = new SessionTokenManager({ expirationMs: 50 });
      manager.stopCleanup();

      manager.generate();
      manager.generate();
      expect(manager.getActiveTokenCount()).toBe(2);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      manager.cleanup();
      expect(manager.getActiveTokenCount()).toBe(0);

      manager.stopCleanup();
    });

    it("should not cleanup non-expired tokens", () => {
      const manager = new SessionTokenManager({ expirationMs: 60000 });
      manager.stopCleanup();

      manager.generate();
      manager.generate();
      expect(manager.getActiveTokenCount()).toBe(2);

      manager.cleanup();
      expect(manager.getActiveTokenCount()).toBe(2);

      manager.stopCleanup();
    });
  });

  describe("Unit Tests - Default Configuration", () => {
    it("should use default 5-minute expiration", () => {
      const manager = new SessionTokenManager();
      manager.stopCleanup();

      const beforeGenerate = Date.now();
      const token = manager.generate();
      const tokenInfo = manager.getTokenInfo(token);

      // Default is 300000ms (5 minutes)
      expect(tokenInfo!.expiresAt - tokenInfo!.createdAt).toBe(300000);

      manager.stopCleanup();
    });
  });
});
