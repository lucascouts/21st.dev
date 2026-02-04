import * as fc from "fast-check";
import { LogoSearchTool } from "./logo-search.js";

// Mock global fetch
const originalFetch = global.fetch;

describe("LogoSearchTool", () => {
  let tool: LogoSearchTool;

  beforeEach(() => {
    tool = new LogoSearchTool();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("tool metadata", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("magic_logo_search");
    });

    it("should have a description", () => {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(0);
    });
  });

  describe("chunk helper", () => {
    it("should split array into chunks of specified size", () => {
      // Access private method via any cast for testing
      const chunk = (tool as any).chunk.bind(tool);
      
      expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
      expect(chunk([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
      expect(chunk([], 3)).toEqual([]);
    });
  });

  describe("parallel fetching with concurrency limit", () => {
    it("should process queries in batches of 5", async () => {
      const fetchCalls: number[] = [];
      let callOrder = 0;

      global.fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        fetchCalls.push(++callOrder);
        
        // Simulate API response
        if (urlStr.includes("api.svgl.app")) {
          return new Response(JSON.stringify([{
            title: "Test",
            route: "https://example.com/test.svg",
            category: "test",
            url: "https://example.com"
          }]), { status: 200 });
        }
        
        // SVG content
        return new Response("<svg></svg>", { status: 200 });
      };

      // 7 queries should result in 2 batches (5 + 2)
      const queries = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"];
      await tool.execute({ queries, format: "SVG" });

      // Each query makes 2 fetch calls (API + SVG), so 14 total
      expect(fetchCalls.length).toBe(14);
    });
  });

  describe("partial failure handling", () => {
    it("should return partial results when some fetches fail", async () => {
      global.fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        
        if (urlStr.includes("api.svgl.app")) {
          if (urlStr.includes("fail")) {
            return new Response(JSON.stringify([{
              title: "Fail",
              route: "https://example.com/fail.svg",
              category: "test",
              url: "https://example.com"
            }]), { status: 200 });
          }
          return new Response(JSON.stringify([{
            title: "Success",
            route: "https://example.com/success.svg",
            category: "test",
            url: "https://example.com"
          }]), { status: 200 });
        }
        
        // SVG fetch - fail for "fail" queries
        if (urlStr.includes("fail.svg")) {
          return new Response("Not Found", { status: 404 });
        }
        
        return new Response("<svg></svg>", { status: 200 });
      };

      const result = await tool.execute({
        queries: ["success1", "fail1", "success2", "fail2"],
        format: "SVG"
      });

      const parsed = JSON.parse(result.content[0].text);
      
      // Should have 2 successful and 2 failed
      expect(parsed.icons.length).toBe(2);
      expect(parsed.notFound.length).toBe(2);
      
      // Failed items should have error messages
      expect(parsed.notFound[0].error).toBeTruthy();
      expect(parsed.notFound[1].error).toBeTruthy();
    });

    it("should handle complete API failure gracefully", async () => {
      global.fetch = async () => {
        return new Response(JSON.stringify([]), { status: 200 });
      };

      const result = await tool.execute({
        queries: ["nonexistent"],
        format: "SVG"
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.icons.length).toBe(0);
      expect(parsed.notFound.length).toBe(1);
      expect(parsed.notFound[0].error).toContain("No logo found");
    });
  });

  /**
   * Property B3: Parallel Fetch Independence
   * For any set of N logo queries where M fail (M < N), the LogoSearchTool
   * SHALL return N-M successful results plus M error markers.
   *
   * **Validates: Requirements B2.3, B2.4**
   */
  describe("Property B3: Parallel Fetch Independence", () => {
    it("should return N-M successful results plus M error markers", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }), // total queries (N)
          fc.integer({ min: 0, max: 10 }), // failures (M)
          async (totalQueries, failureCount) => {
            // Ensure M < N (at least one success possible)
            const actualFailures = Math.min(failureCount, totalQueries - 1);
            const expectedSuccesses = totalQueries - actualFailures;

            // Create query list with some marked to fail
            const queries = Array.from({ length: totalQueries }, (_, i) =>
              i < actualFailures ? `fail_${i}` : `success_${i}`
            );

            // Mock fetch to fail for queries starting with "fail_"
            global.fetch = async (url: RequestInfo | URL) => {
              const urlStr = url.toString();

              if (urlStr.includes("api.svgl.app")) {
                const searchParam = new URL(urlStr).searchParams.get("search") || "";
                return new Response(JSON.stringify([{
                  title: searchParam,
                  route: `https://example.com/${searchParam}.svg`,
                  category: "test",
                  url: "https://example.com"
                }]), { status: 200 });
              }

              // SVG fetch - fail for "fail_" queries
              if (urlStr.includes("fail_")) {
                throw new Error("Simulated fetch failure");
              }

              return new Response("<svg></svg>", { status: 200 });
            };

            const result = await tool.execute({ queries, format: "SVG" });
            const parsed = JSON.parse(result.content[0].text);

            // Property B3: N-M successful + M failed
            const successCount = parsed.icons.length;
            const failCount = parsed.notFound.length;

            return (
              successCount === expectedSuccesses &&
              failCount === actualFailures &&
              successCount + failCount === totalQueries
            );
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should preserve all query results regardless of failure order", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(
            ["a", "b", "c", "d", "e", "f", "g", "h"],
            { minLength: 3, maxLength: 8 }
          ),
          fc.integer({ min: 0, max: 4 }),
          async (queries, failIndex) => {
            const failQuery = queries[failIndex % queries.length];

            global.fetch = async (url: RequestInfo | URL) => {
              const urlStr = url.toString();

              if (urlStr.includes("api.svgl.app")) {
                const searchParam = new URL(urlStr).searchParams.get("search") || "";
                return new Response(JSON.stringify([{
                  title: searchParam,
                  route: `https://example.com/${searchParam}.svg`,
                  category: "test",
                  url: "https://example.com"
                }]), { status: 200 });
              }

              // Fail only the designated query
              if (urlStr.includes(`${failQuery}.svg`)) {
                return new Response("Error", { status: 500 });
              }

              return new Response("<svg></svg>", { status: 200 });
            };

            const result = await tool.execute({ queries, format: "SVG" });
            const parsed = JSON.parse(result.content[0].text);

            // Total results should equal total queries
            const totalResults = parsed.icons.length + parsed.notFound.length;
            
            // Exactly one failure
            return (
              totalResults === queries.length &&
              parsed.notFound.length === 1 &&
              parsed.icons.length === queries.length - 1
            );
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should handle all queries failing", async () => {
      global.fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        
        if (urlStr.includes("api.svgl.app")) {
          // Return empty array - no logos found
          return new Response(JSON.stringify([]), { status: 200 });
        }
        
        return new Response("<svg></svg>", { status: 200 });
      };

      const queries = ["x", "y", "z"];
      const result = await tool.execute({ queries, format: "SVG" });
      const parsed = JSON.parse(result.content[0].text);

      // All should be in notFound
      expect(parsed.icons.length).toBe(0);
      expect(parsed.notFound.length).toBe(3);
    });

    it("should handle all queries succeeding", async () => {
      global.fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        
        if (urlStr.includes("api.svgl.app")) {
          return new Response(JSON.stringify([{
            title: "Logo",
            route: "https://example.com/logo.svg",
            category: "test",
            url: "https://example.com"
          }]), { status: 200 });
        }
        
        return new Response("<svg></svg>", { status: 200 });
      };

      const queries = ["a", "b", "c"];
      const result = await tool.execute({ queries, format: "SVG" });
      const parsed = JSON.parse(result.content[0].text);

      // All should be in icons
      expect(parsed.icons.length).toBe(3);
      expect(parsed.notFound.length).toBe(0);
    });
  });

  describe("format conversion", () => {
    beforeEach(() => {
      global.fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        
        if (urlStr.includes("api.svgl.app")) {
          return new Response(JSON.stringify([{
            title: "TestLogo",
            route: "https://example.com/test.svg",
            category: "test",
            url: "https://example.com"
          }]), { status: 200 });
        }
        
        return new Response('<svg class="icon"></svg>', { status: 200 });
      };
    });

    it("should return raw SVG for SVG format", async () => {
      const result = await tool.execute({ queries: ["test"], format: "SVG" });
      const parsed = JSON.parse(result.content[0].text);
      
      expect(parsed.icons[0].code).toContain("<svg");
      expect(parsed.icons[0].code).toContain('class="icon"');
    });

    it("should convert to JSX format", async () => {
      const result = await tool.execute({ queries: ["test"], format: "JSX" });
      const parsed = JSON.parse(result.content[0].text);
      
      expect(parsed.icons[0].code).toContain("function");
      expect(parsed.icons[0].code).toContain("className=");
    });

    it("should convert to TSX format", async () => {
      const result = await tool.execute({ queries: ["test"], format: "TSX" });
      const parsed = JSON.parse(result.content[0].text);
      
      expect(parsed.icons[0].code).toContain("React.FC");
      expect(parsed.icons[0].code).toContain("className=");
    });
  });
});
