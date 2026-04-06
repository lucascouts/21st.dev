import { describe, it, expect } from "bun:test";
import { ShellSanitizer } from "../../security/shell-sanitizer.js";

describe("ShellSanitizer", () => {
  describe("escapeShellArg", () => {
    it("wraps argument in single quotes", () => {
      const result = ShellSanitizer.escapeShellArg("hello world");
      expect(result).toBe("'hello world'");
    });

    it("escapes single quotes within the argument", () => {
      const result = ShellSanitizer.escapeShellArg("it's");
      expect(result).toBe("'it'\\''s'");
    });

    it("handles empty string", () => {
      const result = ShellSanitizer.escapeShellArg("");
      expect(result).toBe("''");
    });
  });

  describe("sanitizeUrl", () => {
    it("rejects javascript: protocol", () => {
      expect(() => ShellSanitizer.sanitizeUrl("javascript:alert(1)")).toThrow(
        /Invalid URL protocol/
      );
    });

    it("accepts http URLs", () => {
      const result = ShellSanitizer.sanitizeUrl("http://example.com");
      expect(result).toContain("http://example.com");
    });

    it("accepts https URLs", () => {
      const result = ShellSanitizer.sanitizeUrl("https://example.com");
      expect(result).toContain("https://example.com");
    });

    it("throws on empty string", () => {
      expect(() => ShellSanitizer.sanitizeUrl("")).toThrow();
    });
  });

  describe("containsShellMetachars", () => {
    it("detects semicolons", () => {
      expect(ShellSanitizer.containsShellMetachars("cmd; rm -rf /")).toBe(true);
    });

    it("detects pipes", () => {
      expect(ShellSanitizer.containsShellMetachars("echo | cat")).toBe(true);
    });

    it("detects backticks", () => {
      expect(ShellSanitizer.containsShellMetachars("echo `whoami`")).toBe(true);
    });

    it("detects dollar sign", () => {
      expect(ShellSanitizer.containsShellMetachars("echo $HOME")).toBe(true);
    });

    it("returns false for safe strings", () => {
      expect(ShellSanitizer.containsShellMetachars("hello-world_123")).toBe(false);
    });

    it("returns false for empty or falsy input", () => {
      expect(ShellSanitizer.containsShellMetachars("")).toBe(false);
    });
  });
});
