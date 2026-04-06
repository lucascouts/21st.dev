import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { sanitizeSvg } from "../../http/svg-sanitizer.js";

describe("SvgSanitizer property tests", () => {
  it("should never contain <script after sanitization", () => {
    fc.assert(fc.property(fc.string(), (input) => {
      const result = sanitizeSvg(`<svg>${input}<script>alert(1)</script></svg>`);
      expect(result).not.toContain("<script");
    }));
  });

  it("should never contain onclick after sanitization", () => {
    fc.assert(fc.property(fc.string(), (input) => {
      const result = sanitizeSvg(`<svg><rect onclick="alert(1)" />${input}</svg>`);
      expect(result).not.toMatch(/onclick/i);
    }));
  });

  it("should never contain javascript: after sanitization", () => {
    fc.assert(fc.property(fc.string(), (input) => {
      const result = sanitizeSvg(`<svg><a href="javascript:alert(1)">${input}</a></svg>`);
      expect(result).not.toContain("javascript:");
    }));
  });
});
