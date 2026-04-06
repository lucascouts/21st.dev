import { describe, it, expect } from "bun:test";
import { LogSanitizer } from "../../security/log-sanitizer.js";

describe("LogSanitizer.sanitize", () => {
  it("redacts API key patterns (sk-xxx)", () => {
    const input = "key is sk-abc1234567890abcdef";
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abc1234567890abcdef");
  });

  it("redacts API key patterns (pk-xxx)", () => {
    const input = "pk-abc1234567890abcdef";
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts api_xxx patterns", () => {
    const input = "api_abc1234567890abcdef";
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts key_xxx patterns", () => {
    const input = "key_abc1234567890abcdef";
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts AWS AKIA key pattern", () => {
    const input = "aws key AKIAIOSFODNN7EXAMPLE";
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts Bearer token pattern", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123";
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts hex tokens (64+ chars)", () => {
    const hexToken = "a".repeat(64);
    const input = `token=${hexToken}`;
    const result = LogSanitizer.sanitize(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(hexToken);
  });

  it("leaves normal text untouched", () => {
    const input = "Hello, this is a normal log message with no secrets.";
    const result = LogSanitizer.sanitize(input);
    expect(result).toBe(input);
  });

  it("produces correct results on multiple consecutive calls (lastIndex bug fix)", () => {
    const input1 = "Bearer token1234567890abcdef1234";
    const input2 = "Bearer anothertoken1234567890abcdef";
    const result1 = LogSanitizer.sanitize(input1);
    const result2 = LogSanitizer.sanitize(input2);
    expect(result1).toContain("[REDACTED]");
    expect(result2).toContain("[REDACTED]");
    // Third call to ensure no lastIndex state leaks
    const result3 = LogSanitizer.sanitize(input1);
    expect(result3).toContain("[REDACTED]");
  });
});
