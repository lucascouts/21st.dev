import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { LogSanitizer } from "../../security/log-sanitizer.js";

describe("LogSanitizer property tests", () => {
  it("redacts any string containing Bearer followed by 20+ alphanumeric chars", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9._-]{20,60}$/),
        (token) => {
          const input = `Authorization: Bearer ${token}`;
          const result = LogSanitizer.sanitize(input);
          expect(result).toContain("[REDACTED]");
        }
      )
    );
  });

  it("redacts any string containing AKIA followed by 16 uppercase chars", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{16}$/),
        (suffix) => {
          const input = `aws key AKIA${suffix} found`;
          const result = LogSanitizer.sanitize(input);
          expect(result).toContain("[REDACTED]");
        }
      )
    );
  });
});
