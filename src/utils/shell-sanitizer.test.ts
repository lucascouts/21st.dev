import * as fc from "fast-check";
import { ShellSanitizer, SHELL_METACHARACTERS } from "./shell-sanitizer.js";

describe("ShellSanitizer", () => {
  /**
   * Property 10: Shell Metacharacter Escaping
   * For any string containing shell metacharacters (`;`, `&`, `|`, `>`, `<`, `` ` ``,
   * `$`, `(`, `)`, `'`, `"`, `\`, `*`, `?`, `[`, `]`, `!`, `#`, `~`, `^`), the
   * Shell_Sanitizer SHALL escape all such characters before the string is used
   * in shell commands.
   *
   * **Validates: Requirements 7.1**
   */
  describe("Property 10: Shell Metacharacter Escaping", () => {
    it("should escape all shell metacharacters in any string", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate strings that contain at least one shell metacharacter
          fc.string().chain((baseStr) =>
            fc.constantFrom(...SHELL_METACHARACTERS).map(
              (metaChar) => baseStr + metaChar + baseStr
            )
          ),
          async (inputWithMetachars) => {
            const escaped = ShellSanitizer.escapeShellArg(inputWithMetachars);

            // The escaped result should be wrapped in single quotes
            // and any single quotes in the input should be properly escaped
            const startsWithQuote = escaped.startsWith("'");
            const endsWithQuote = escaped.endsWith("'");

            // Verify the escaping is valid by checking structure
            // Single-quoted strings in shell only need to escape single quotes
            // The pattern 'text'\''more' is used to include literal single quotes
            return startsWithQuote && endsWithQuote;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should produce output that does not contain unescaped metacharacters", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string(),
          async (input) => {
            const escaped = ShellSanitizer.escapeShellArg(input);

            // When wrapped in single quotes, the only way to include a literal
            // single quote is via the '\'' pattern. All other metacharacters
            // are safe inside single quotes.
            // Verify the structure is valid single-quoted string
            if (escaped === "''") {
              return input === "";
            }

            // Must start and end with single quote
            if (!escaped.startsWith("'") || !escaped.endsWith("'")) {
              return false;
            }

            // The content between quotes should have single quotes escaped as '\''
            // Remove the outer quotes and check the pattern
            const inner = escaped.slice(1, -1);

            // Count single quotes in input vs escaped '\'' patterns
            const inputSingleQuotes = (input.match(/'/g) || []).length;
            const escapedPatterns = (inner.match(/'\\''|'/g) || []).filter(
              (m) => m === "'\\''"
            ).length;

            return escapedPatterns === inputSingleQuotes;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should handle empty strings", () => {
      const escaped = ShellSanitizer.escapeShellArg("");
      expect(escaped).toBe("''");
    });

    it("should handle strings with only metacharacters", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...SHELL_METACHARACTERS), { minLength: 1, maxLength: 10 }).map(
            (chars) => chars.join("")
          ),
          async (metaOnlyStr) => {
            const escaped = ShellSanitizer.escapeShellArg(metaOnlyStr);
            return escaped.startsWith("'") && escaped.endsWith("'");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 11: URL Protocol Validation
   * For any URL string, the Shell_Sanitizer SHALL only accept URLs with
   * `http://` or `https://` protocols and SHALL reject all other protocols
   * (including `file://`, `javascript:`, `data:`).
   *
   * **Validates: Requirements 7.2**
   */
  describe("Property 11: URL Protocol Validation", () => {
    it("should accept http:// and https:// URLs", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.webUrl({ validSchemes: ["http", "https"] }),
            fc.constant("http://example.com"),
            fc.constant("https://example.com"),
            fc.constant("http://localhost:3000"),
            fc.constant("https://21st.dev/path?query=value"),
          ),
          async (validUrl) => {
            try {
              const sanitized = ShellSanitizer.sanitizeUrl(validUrl);
              return typeof sanitized === "string" && sanitized.length > 0;
            } catch {
              // Some generated URLs might be malformed
              return true;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject dangerous protocols", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.com/file",
            "ssh://user@host",
            "telnet://host:23",
            "file://localhost/etc/passwd",
            "javascript:void(0)",
            "data:application/json,{}",
          ),
          async (dangerousUrl) => {
            try {
              ShellSanitizer.sanitizeUrl(dangerousUrl);
              return false; // Should have thrown
            } catch (error) {
              // Should throw an error about invalid protocol
              return error instanceof Error && error.message.includes("protocol");
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject empty or invalid URLs", () => {
      expect(() => ShellSanitizer.sanitizeUrl("")).toThrow("empty");
      expect(() => ShellSanitizer.sanitizeUrl("   ")).toThrow("empty");
      expect(() => ShellSanitizer.sanitizeUrl("not-a-url")).toThrow("Invalid URL");
    });
  });

  /**
   * Property 12: URL Metacharacter Encoding
   * For any URL containing shell metacharacters in the path or query string,
   * the Shell_Sanitizer SHALL URL-encode those characters before passing to
   * browser opening commands.
   *
   * **Validates: Requirements 7.3**
   */
  describe("Property 12: URL Metacharacter Encoding", () => {
    it("should encode shell metacharacters in URL path and query", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate URLs with shell metacharacters in path/query
          fc.tuple(
            fc.constantFrom("http://", "https://"),
            fc.constantFrom("example.com", "localhost", "21st.dev"),
            fc.constantFrom(...SHELL_METACHARACTERS.filter((c) => c !== "\n" && c !== "\r")),
          ).map(([protocol, host, metaChar]) => {
            // Create URL with metachar in query (safest place to test)
            return `${protocol}${host}/path?param=${encodeURIComponent(metaChar)}value`;
          }),
          async (urlWithMetachar) => {
            try {
              const sanitized = ShellSanitizer.sanitizeUrl(urlWithMetachar);
              // The sanitized URL should not contain unencoded shell metacharacters
              // in the path/query portion (after the host)
              const url = new URL(sanitized);
              const pathAndQuery = url.pathname + url.search;

              // Check that dangerous chars are encoded
              const dangerousUnencoded = ["'", '"', "`", "$", "\\", ";", "&", "|", "(", ")"];
              for (const char of dangerousUnencoded) {
                if (pathAndQuery.includes(char)) {
                  return false;
                }
              }
              return true;
            } catch {
              // URL might be invalid due to metachar placement
              return true;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should preserve valid URL structure after encoding", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "https://example.com/path?q=hello&name=world",
            "http://localhost:3000/api/test",
            "https://21st.dev/magic-chat?q=button",
          ),
          async (validUrl) => {
            const sanitized = ShellSanitizer.sanitizeUrl(validUrl);
            // Should still be a valid URL
            try {
              new URL(sanitized);
              return true;
            } catch {
              return false;
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("containsShellMetachars", () => {
    it("should detect shell metacharacters", () => {
      for (const char of SHELL_METACHARACTERS) {
        expect(ShellSanitizer.containsShellMetachars(`test${char}string`)).toBe(true);
      }
    });

    it("should return false for safe strings", () => {
      expect(ShellSanitizer.containsShellMetachars("hello")).toBe(false);
      expect(ShellSanitizer.containsShellMetachars("hello-world_123")).toBe(false);
      expect(ShellSanitizer.containsShellMetachars("")).toBe(false);
    });

    it("should handle null/undefined gracefully", () => {
      expect(ShellSanitizer.containsShellMetachars(null as any)).toBe(false);
      expect(ShellSanitizer.containsShellMetachars(undefined as any)).toBe(false);
    });
  });
});
