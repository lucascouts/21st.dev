import * as fc from "fast-check";
import {
  CreateUiTool,
  resetDisplayEnvCache,
  resetBrowserCache,
  getDisplayEnvCacheState,
  getBrowserCacheState,
} from "./create-ui.js";

/**
 * Property 14: Display Environment Caching
 * For any sequence of browser launch operations within a single process,
 * the display environment detection SHALL be performed only once and the
 * cached result SHALL be reused for all subsequent launches.
 *
 * **Validates: Requirements 10.2, 10.3**
 */
describe("Property 14: Display Environment Caching", () => {
  // Reset caches before each test to ensure isolation
  beforeEach(() => {
    resetDisplayEnvCache();
    resetBrowserCache();
  });

  afterEach(() => {
    resetDisplayEnvCache();
    resetBrowserCache();
  });

  describe("Display Environment Cache", () => {
    it("should cache display environment after first detection", async () => {
      const tool = new CreateUiTool();

      // Access private method via any cast (for testing purposes)
      const getDisplayEnv = (tool as any).getDisplayEnv.bind(tool);

      // First call should populate the cache
      const firstResult = await getDisplayEnv();
      const cacheAfterFirst = getDisplayEnvCacheState();

      expect(cacheAfterFirst).not.toBeNull();
      expect(cacheAfterFirst?.env).toEqual(firstResult);
      expect(cacheAfterFirst?.detectedAt).toBeLessThanOrEqual(Date.now());

      // Second call should return cached result
      const secondResult = await getDisplayEnv();
      const cacheAfterSecond = getDisplayEnvCacheState();

      // Cache should be the same object (same detectedAt timestamp)
      expect(cacheAfterSecond?.detectedAt).toBe(cacheAfterFirst?.detectedAt);
      expect(secondResult).toEqual(firstResult);
    });

    it("should return identical results for multiple sequential calls", async () => {
      // Property: For any number of calls N >= 2, all calls return the same result
      // and the cache timestamp remains constant after the first call
      await fc.assert(
        fc.asyncProperty(
          // Generate number of calls between 2 and 10
          fc.integer({ min: 2, max: 10 }),
          async (numCalls) => {
            // Reset cache at the start of each property iteration
            resetDisplayEnvCache();

            const tool = new CreateUiTool();
            const getDisplayEnv = (tool as any).getDisplayEnv.bind(tool);

            // Make first call and record the result
            const firstResult = await getDisplayEnv();
            const firstCacheState = getDisplayEnvCacheState();
            
            if (firstCacheState === null) {
              return false; // Cache should be populated after first call
            }
            
            const firstDetectedAt = firstCacheState.detectedAt;

            // Make subsequent calls and verify they return the same result
            for (let i = 1; i < numCalls; i++) {
              const result = await getDisplayEnv();
              const currentCacheState = getDisplayEnvCacheState();

              // Results should be identical (compare by value)
              const firstResultStr = JSON.stringify(firstResult);
              const resultStr = JSON.stringify(result);
              if (resultStr !== firstResultStr) {
                return false;
              }

              // Cache timestamp should not change (proving cache is reused)
              if (currentCacheState?.detectedAt !== firstDetectedAt) {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Browser Cache", () => {
    it("should cache browser detection after first call", async () => {
      const tool = new CreateUiTool();

      // Access private method via any cast (for testing purposes)
      const getDefaultBrowser = (tool as any).getDefaultBrowser.bind(tool);

      // First call should populate the cache
      const firstResult = await getDefaultBrowser();
      const cacheAfterFirst = getBrowserCacheState();

      expect(cacheAfterFirst).not.toBeNull();
      expect(cacheAfterFirst?.browser).toBe(firstResult);
      expect(cacheAfterFirst?.detectedAt).toBeLessThanOrEqual(Date.now());

      // Second call should return cached result
      const secondResult = await getDefaultBrowser();
      const cacheAfterSecond = getBrowserCacheState();

      // Cache should be the same object (same detectedAt timestamp)
      expect(cacheAfterSecond?.detectedAt).toBe(cacheAfterFirst?.detectedAt);
      expect(secondResult).toBe(firstResult);
    });

    it("should return identical browser results for multiple sequential calls", async () => {
      // Property: For any number of calls N >= 2, all calls return the same result
      // and the cache timestamp remains constant after the first call
      await fc.assert(
        fc.asyncProperty(
          // Generate number of calls between 2 and 10
          fc.integer({ min: 2, max: 10 }),
          async (numCalls) => {
            // Reset cache at the start of each property iteration
            resetBrowserCache();

            const tool = new CreateUiTool();
            const getDefaultBrowser = (tool as any).getDefaultBrowser.bind(tool);

            // Make first call and record the result
            const firstResult = await getDefaultBrowser();
            const firstCacheState = getBrowserCacheState();
            
            if (firstCacheState === null) {
              return false; // Cache should be populated after first call
            }
            
            const firstDetectedAt = firstCacheState.detectedAt;

            // Make subsequent calls and verify they return the same result
            for (let i = 1; i < numCalls; i++) {
              const result = await getDefaultBrowser();
              const currentCacheState = getBrowserCacheState();

              // Results should be identical
              if (result !== firstResult) {
                return false;
              }

              // Cache timestamp should not change (proving cache is reused)
              if (currentCacheState?.detectedAt !== firstDetectedAt) {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Combined Caching Behavior", () => {
    it("should maintain independent caches for display env and browser", async () => {
      // Property: Display env and browser caches are independent
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (callDisplayFirst) => {
          // Reset both caches at the start of each property iteration
          resetDisplayEnvCache();
          resetBrowserCache();

          const tool = new CreateUiTool();
          const getDisplayEnv = (tool as any).getDisplayEnv.bind(tool);
          const getDefaultBrowser = (tool as any).getDefaultBrowser.bind(tool);

          if (callDisplayFirst) {
            await getDisplayEnv();
            // Display cache should be populated, browser cache should be null
            if (getDisplayEnvCacheState() === null) return false;
            if (getBrowserCacheState() !== null) return false;

            await getDefaultBrowser();
            // Both caches should now be populated
            if (getDisplayEnvCacheState() === null) return false;
            if (getBrowserCacheState() === null) return false;
          } else {
            await getDefaultBrowser();
            // Browser cache should be populated, display cache should be null
            if (getBrowserCacheState() === null) return false;
            if (getDisplayEnvCacheState() !== null) return false;

            await getDisplayEnv();
            // Both caches should now be populated
            if (getDisplayEnvCacheState() === null) return false;
            if (getBrowserCacheState() === null) return false;
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
