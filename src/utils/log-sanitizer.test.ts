import * as fc from "fast-check";
import { LogSanitizer } from "./log-sanitizer.js";

describe("LogSanitizer", () => {
  /**
   * Property A4: Log Redaction Completeness
   * For any string containing patterns matching API keys (20+ alphanumeric chars),
   * the LogSanitizer SHALL replace all matches with `[REDACTED]`.
   *
   * **Validates: Requirement A3.1**
   */
  describe("Property A4: Log Redaction Completeness", () => {
    // Arbitrary for generating API key-like strings (20+ alphanumeric chars)
    const apiKeyArb = fc.string({
      minLength: 20,
      maxLength: 64,
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("")
      ),
    });

    it("should redact all API key patterns (20+ alphanumeric chars)", () => {
      fc.assert(
        fc.property(
          fc.array(apiKeyArb, { minLength: 1, maxLength: 5 }),
          (apiKeys) => {
            // Create input with API keys embedded in text
            const input = apiKeys.map((key) => `key=${key}`).join(" ");
            const result = LogSanitizer.sanitize(input);

            // Verify no API keys remain in output
            for (const key of apiKeys) {
              if (result.includes(key)) {
                return false;
              }
            }

            // Verify [REDACTED] appears for each key
            const redactedCount = (result.match(/\[REDACTED\]/g) || []).length;
            return redactedCount === apiKeys.length;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should not redact strings shorter than 20 characters", () => {
      const shortStringArb = fc.string({
        minLength: 1,
        maxLength: 19,
        unit: fc.constantFrom(
          ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("")
        ),
      });

      fc.assert(
        fc.property(shortStringArb, (shortString) => {
          const result = LogSanitizer.sanitize(shortString);
          return result === shortString;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Unit Tests - sanitize() (Requirement A3.1, A3.4)", () => {
    it("should redact API keys matching 20+ alphanumeric pattern", () => {
      const input = "API key: sk_live_abcdefghij1234567890";
      const result = LogSanitizer.sanitize(input);
      expect(result).toBe("API key: [REDACTED]");
    });

    it("should redact multiple API keys in same string", () => {
      const input = "key1=abcdefghij1234567890 key2=ABCDEFGHIJ0987654321";
      const result = LogSanitizer.sanitize(input);
      expect(result).toBe("key1=[REDACTED] key2=[REDACTED]");
    });

    it("should not redact short strings", () => {
      const input = "short_key=abc123";
      const result = LogSanitizer.sanitize(input);
      expect(result).toBe("short_key=abc123");
    });

    it("should handle empty string", () => {
      expect(LogSanitizer.sanitize("")).toBe("");
    });

    it("should handle null/undefined gracefully", () => {
      expect(LogSanitizer.sanitize(null as unknown as string)).toBe(null);
      expect(LogSanitizer.sanitize(undefined as unknown as string)).toBe(undefined);
    });

    it("should support custom patterns", () => {
      const input = "secret: mysecret123";
      const result = LogSanitizer.sanitize(input, {
        patterns: [/mysecret\d+/g],
      });
      expect(result).toBe("secret: [REDACTED]");
    });
  });

  describe("Unit Tests - sanitizeUrl() (Requirement A3.2, A3.4)", () => {
    it("should redact sensitive query parameters", () => {
      const url = "https://api.example.com/data?key=secret123&name=test";
      const result = LogSanitizer.sanitizeUrl(url);
      // URL encoding converts [ to %5B and ] to %5D
      expect(result).toMatch(/key=(\[REDACTED\]|%5BREDACTED%5D)/);
      expect(result).toContain("name=test");
    });

    it("should redact token parameter", () => {
      const url = "https://example.com?token=abc123xyz";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toMatch(/token=(\[REDACTED\]|%5BREDACTED%5D)/);
    });

    it("should redact secret parameter", () => {
      const url = "https://example.com?secret=mysecret";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toMatch(/secret=(\[REDACTED\]|%5BREDACTED%5D)/);
    });

    it("should redact password parameter", () => {
      const url = "https://example.com?password=pass123";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toMatch(/password=(\[REDACTED\]|%5BREDACTED%5D)/);
    });

    it("should redact api_key parameter", () => {
      const url = "https://example.com?api_key=key123";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toMatch(/api_key=(\[REDACTED\]|%5BREDACTED%5D)/);
    });

    it("should redact apikey parameter (no underscore)", () => {
      const url = "https://example.com?apikey=key123";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toMatch(/apikey=(\[REDACTED\]|%5BREDACTED%5D)/);
    });

    it("should handle URLs without sensitive params", () => {
      const url = "https://example.com?page=1&sort=asc";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toBe(url);
    });

    it("should handle empty string", () => {
      expect(LogSanitizer.sanitizeUrl("")).toBe("");
    });

    it("should handle null/undefined gracefully", () => {
      expect(LogSanitizer.sanitizeUrl(null as unknown as string)).toBe(null);
      expect(LogSanitizer.sanitizeUrl(undefined as unknown as string)).toBe(undefined);
    });

    it("should handle relative URLs with query strings", () => {
      const url = "/api/data?key=secret123";
      const result = LogSanitizer.sanitizeUrl(url);
      expect(result).toMatch(/key=(\[REDACTED\]|%5BREDACTED%5D)/);
    });
  });

  describe("Unit Tests - sanitizeHeaders() (Requirement A3.3, A3.4)", () => {
    it("should redact x-api-key header", () => {
      const headers = { "x-api-key": "secret-key-123", "content-type": "application/json" };
      const result = LogSanitizer.sanitizeHeaders(headers);
      expect(result["x-api-key"]).toBe("[REDACTED]");
      expect(result["content-type"]).toBe("application/json");
    });

    it("should redact authorization header", () => {
      const headers = { authorization: "Bearer token123" };
      const result = LogSanitizer.sanitizeHeaders(headers);
      expect(result.authorization).toBe("[REDACTED]");
    });

    it("should redact cookie header", () => {
      const headers = { cookie: "session=abc123" };
      const result = LogSanitizer.sanitizeHeaders(headers);
      expect(result.cookie).toBe("[REDACTED]");
    });

    it("should handle case-insensitive header names", () => {
      const headers = {
        "X-API-KEY": "secret",
        "Authorization": "Bearer token",
        "COOKIE": "session=123",
      };
      const result = LogSanitizer.sanitizeHeaders(headers);
      expect(result["X-API-KEY"]).toBe("[REDACTED]");
      expect(result["Authorization"]).toBe("[REDACTED]");
      expect(result["COOKIE"]).toBe("[REDACTED]");
    });

    it("should preserve non-sensitive headers", () => {
      const headers = {
        "content-type": "application/json",
        "accept": "text/html",
        "user-agent": "Mozilla/5.0",
      };
      const result = LogSanitizer.sanitizeHeaders(headers);
      expect(result).toEqual(headers);
    });

    it("should handle empty object", () => {
      expect(LogSanitizer.sanitizeHeaders({})).toEqual({});
    });

    it("should handle null/undefined gracefully", () => {
      expect(LogSanitizer.sanitizeHeaders(null as unknown as Record<string, string>)).toBe(null);
      expect(LogSanitizer.sanitizeHeaders(undefined as unknown as Record<string, string>)).toBe(undefined);
    });

    it("should return new object without modifying original", () => {
      const original = { "x-api-key": "secret" };
      const result = LogSanitizer.sanitizeHeaders(original);
      expect(result).not.toBe(original);
      expect(original["x-api-key"]).toBe("secret");
    });
  });
});
