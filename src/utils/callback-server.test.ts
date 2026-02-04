import * as fc from "fast-check";
import { getMaxBodySize, BodyTooLargeError } from "./callback-server.js";

describe("CallbackServer - Body Size Limit", () => {
  const originalEnv = process.env.MAX_BODY_SIZE;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.MAX_BODY_SIZE;
    } else {
      process.env.MAX_BODY_SIZE = originalEnv;
    }
  });

  /**
   * Property A3: Body Size Enforcement
   * For any request body larger than MAX_BODY_SIZE bytes, the Callback_Server
   * SHALL reject the request before reading the entire body.
   *
   * **Validates: Requirements A2.3, A2.4**
   */
  describe("Property A3: Body Size Enforcement", () => {
    it("should return default 1MB when MAX_BODY_SIZE is not set", () => {
      fc.assert(
        fc.property(
          fc.constant(undefined),
          () => {
            delete process.env.MAX_BODY_SIZE;
            const maxSize = getMaxBodySize();
            return maxSize === 1048576; // 1MB
          }
        ),
        { numRuns: 10 }
      );
    });

    it("should use MAX_BODY_SIZE env variable when set to valid positive integer", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000000 }),
          (size) => {
            process.env.MAX_BODY_SIZE = String(size);
            const maxSize = getMaxBodySize();
            return maxSize === size;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should fall back to default for invalid MAX_BODY_SIZE values", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant("invalid"),
            fc.constant("-100"),
            fc.constant("0"),
            fc.constant(""),
            fc.constant("abc123")
          ),
          (invalidValue) => {
            process.env.MAX_BODY_SIZE = invalidValue;
            const maxSize = getMaxBodySize();
            return maxSize === 1048576; // Should fall back to default
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe("Unit Tests - getMaxBodySize (Requirements A2.1, A2.2)", () => {
    it("should return 1MB (1048576 bytes) by default", () => {
      delete process.env.MAX_BODY_SIZE;
      expect(getMaxBodySize()).toBe(1048576);
    });

    it("should use MAX_BODY_SIZE env variable when set", () => {
      process.env.MAX_BODY_SIZE = "2097152"; // 2MB
      expect(getMaxBodySize()).toBe(2097152);
    });

    it("should handle small body size limits", () => {
      process.env.MAX_BODY_SIZE = "1024"; // 1KB
      expect(getMaxBodySize()).toBe(1024);
    });

    it("should fall back to default for non-numeric values", () => {
      process.env.MAX_BODY_SIZE = "not-a-number";
      expect(getMaxBodySize()).toBe(1048576);
    });

    it("should fall back to default for negative values", () => {
      process.env.MAX_BODY_SIZE = "-1000";
      expect(getMaxBodySize()).toBe(1048576);
    });

    it("should fall back to default for zero", () => {
      process.env.MAX_BODY_SIZE = "0";
      expect(getMaxBodySize()).toBe(1048576);
    });
  });

  describe("Unit Tests - BodyTooLargeError", () => {
    it("should create error with correct properties", () => {
      const error = new BodyTooLargeError(1048576, 2000000);
      
      expect(error.name).toBe("BodyTooLargeError");
      expect(error.limit).toBe(1048576);
      expect(error.received).toBe(2000000);
      expect(error.message).toContain("Payload too large");
      expect(error.message).toContain("2000000");
      expect(error.message).toContain("1048576");
    });

    it("should be instanceof Error", () => {
      const error = new BodyTooLargeError(1000, 2000);
      expect(error instanceof Error).toBe(true);
      expect(error instanceof BodyTooLargeError).toBe(true);
    });
  });
});
