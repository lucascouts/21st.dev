import * as fc from "fast-check";
import { CorsHandler, ALLOWED_ORIGINS } from "./cors-handler.js";

describe("CorsHandler", () => {
  /**
   * Property 7: 21st.dev Subdomain Acceptance
   * For any origin matching the pattern `https://*.21st.dev` or `http://*.21st.dev`,
   * the CORS handler SHALL allow the request.
   *
   * **Validates: Requirements 5.2**
   */
  describe("Property 7: 21st.dev Subdomain Acceptance", () => {
    it("should accept any valid subdomain of 21st.dev", () => {
      fc.assert(
        fc.property(
          // Generate valid subdomain names (alphanumeric, 1-10 chars)
          fc.stringMatching(/^[a-z0-9]{1,10}$/),
          // Generate protocol
          fc.constantFrom("http", "https"),
          // Optionally generate port
          fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
          (subdomain, protocol, port) => {
            const portSuffix = port !== undefined ? `:${port}` : "";
            const origin = `${protocol}://${subdomain}.21st.dev${portSuffix}`;
            
            return CorsHandler.isAllowedOrigin(origin) === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should accept the root 21st.dev domain", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("http", "https"),
          fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
          (protocol, port) => {
            const portSuffix = port !== undefined ? `:${port}` : "";
            const origin = `${protocol}://21st.dev${portSuffix}`;
            
            return CorsHandler.isAllowedOrigin(origin) === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should accept multi-level subdomains of 21st.dev", () => {
      fc.assert(
        fc.property(
          // Generate valid subdomain parts
          fc.array(
            fc.stringMatching(/^[a-z0-9]{1,8}$/),
            { minLength: 1, maxLength: 3 }
          ),
          fc.constantFrom("http", "https"),
          (subdomainParts, protocol) => {
            const subdomain = subdomainParts.join(".");
            const origin = `${protocol}://${subdomain}.21st.dev`;
            
            return CorsHandler.isAllowedOrigin(origin) === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 8: Non-Allowed Origin Rejection
   * For any origin that is not localhost (127.0.0.1, ::1) and does not match
   * `*.21st.dev`, the CORS handler SHALL reject the request with 403 Forbidden.
   *
   * **Validates: Requirements 5.3**
   */
  describe("Property 8: Non-Allowed Origin Rejection", () => {
    it("should reject origins from non-allowed domains", () => {
      fc.assert(
        fc.property(
          // Generate random domain names that are NOT 21st.dev or localhost
          fc.tuple(
            fc.stringMatching(/^[a-z0-9]{3,10}$/),
            fc.constantFrom(".com", ".org", ".net", ".io", ".co", ".app")
          ).map(([name, tld]) => name + tld)
            .filter(domain => 
              !domain.includes("21st") && 
              !domain.includes("localhost")
            ),
          fc.constantFrom("http", "https"),
          fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
          (domain, protocol, port) => {
            const portSuffix = port !== undefined ? `:${port}` : "";
            const origin = `${protocol}://${domain}${portSuffix}`;
            
            return CorsHandler.isAllowedOrigin(origin) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject origins with similar but different domain names", () => {
      fc.assert(
        fc.property(
          // Generate domains that look similar to 21st.dev but aren't
          fc.constantFrom(
            "21st.dev.evil.com",
            "fake21st.dev",
            "21st-dev.com",
            "21stdev.com",
            "21st.dev.com",
            "not21st.dev",
            "21st.devv",
            "21st.de",
            "21st.d",
            "evil.com/21st.dev",
            "21st.dev.attacker.com"
          ),
          fc.constantFrom("http", "https"),
          (domain, protocol) => {
            const origin = `${protocol}://${domain}`;
            
            return CorsHandler.isAllowedOrigin(origin) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject file:// and other non-http protocols", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.com",
            "ws://example.com",
            "wss://example.com"
          ),
          (origin) => {
            return CorsHandler.isAllowedOrigin(origin) === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Localhost Acceptance (Requirement 5.1)", () => {
    it("should accept localhost variations", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            "http://localhost",
            "https://localhost",
            "http://localhost:3000",
            "https://localhost:8080",
            "http://127.0.0.1",
            "https://127.0.0.1",
            "http://127.0.0.1:3000",
            "https://127.0.0.1:8080",
            "http://[::1]",
            "https://[::1]",
            "http://[::1]:3000",
            "https://[::1]:8080"
          ),
          (origin) => {
            return CorsHandler.isAllowedOrigin(origin) === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should accept localhost with any port number", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("localhost", "127.0.0.1", "[::1]"),
          fc.constantFrom("http", "https"),
          fc.integer({ min: 1, max: 65535 }),
          (host, protocol, port) => {
            const origin = `${protocol}://${host}:${port}`;
            
            return CorsHandler.isAllowedOrigin(origin) === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("getCorsHeaders", () => {
    it("should include Access-Control-Allow-Origin for allowed origins", () => {
      const allowedOrigins = [
        "http://localhost:3000",
        "https://21st.dev",
        "https://app.21st.dev",
        "http://127.0.0.1:8080"
      ];

      for (const origin of allowedOrigins) {
        const headers = CorsHandler.getCorsHeaders(origin);
        expect(headers["Access-Control-Allow-Origin"]).toBe(origin);
        expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
        expect(headers["Access-Control-Allow-Headers"]).toBe("Content-Type");
      }
    });

    it("should NOT include Access-Control-Allow-Origin for disallowed origins", () => {
      const disallowedOrigins = [
        "https://evil.com",
        "https://attacker.org",
        "https://fake21st.dev"
      ];

      for (const origin of disallowedOrigins) {
        const headers = CorsHandler.getCorsHeaders(origin);
        expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
        expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
      }
    });

    it("should handle undefined origin", () => {
      const headers = CorsHandler.getCorsHeaders(undefined);
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
    });

    it("should handle empty string origin", () => {
      const headers = CorsHandler.getCorsHeaders("");
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    });
  });

  describe("Edge Cases", () => {
    it("should handle null-like values gracefully", () => {
      expect(CorsHandler.isAllowedOrigin(undefined)).toBe(true);
      expect(CorsHandler.isAllowedOrigin("")).toBe(true);
      expect(CorsHandler.isAllowedOrigin("   ")).toBe(true);
    });

    it("should be case-sensitive for domain matching", () => {
      // Domain names should be lowercase
      expect(CorsHandler.isAllowedOrigin("https://21ST.DEV")).toBe(false);
      expect(CorsHandler.isAllowedOrigin("https://APP.21ST.DEV")).toBe(false);
    });
  });
});
