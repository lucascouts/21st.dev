import * as fc from "fast-check";
import {
  BASE_URL,
  DEFAULT_TIMEOUT,
  getTimeout,
  calculateBackoffDelay,
  shouldRetry,
  DEFAULT_RETRY_CONFIG,
  TimeoutError,
} from "./http-client.js";

describe("http-client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should use production URL in production environment", () => {
    expect(BASE_URL).toBe("https://magic.21st.dev");
  });

  /**
   * Property 3: Timeout Configuration
   * For any positive integer value set in the TWENTY_FIRST_TIMEOUT environment
   * variable, the HTTP_Client SHALL use that exact value (in milliseconds) as
   * the request timeout.
   *
   * **Validates: Requirements 3.2**
   */
  describe("Property 3: Timeout Configuration", () => {
    it("should use TWENTY_FIRST_TIMEOUT environment variable when set", () => {
      fc.assert(
        fc.property(
          // Generate positive integers for timeout values
          fc.integer({ min: 1, max: 300000 }),
          (timeoutValue) => {
            process.env.TWENTY_FIRST_TIMEOUT = String(timeoutValue);

            // Re-import to get fresh getTimeout function
            const timeout = getTimeout();

            // The timeout should exactly match the environment variable
            return timeout === timeoutValue;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should use default timeout when environment variable is invalid", () => {
      fc.assert(
        fc.property(
          // Generate strings that are NOT valid positive integers
          fc.oneof(
            fc.constant(undefined),
            fc.constant(""),
            fc.constant("abc"),
            fc.constant("-100"),
            fc.constant("0"),
            fc.constant("NaN")
          ),
          (invalidValue) => {
            if (invalidValue === undefined) {
              delete process.env.TWENTY_FIRST_TIMEOUT;
            } else {
              process.env.TWENTY_FIRST_TIMEOUT = invalidValue;
            }

            const timeout = getTimeout();

            // Should fall back to default timeout
            return timeout === DEFAULT_TIMEOUT;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should return exactly 30000ms as default timeout", () => {
      delete process.env.TWENTY_FIRST_TIMEOUT;
      expect(getTimeout()).toBe(30000);
      expect(DEFAULT_TIMEOUT).toBe(30000);
    });
  });


  /**
   * Property 4: 5xx Retry Behavior
   * For any HTTP response with a status code in the range 500-599, the
   * HTTP_Client SHALL retry the request up to 3 times before failing.
   *
   * **Validates: Requirements 4.1**
   */
  describe("Property 4: 5xx Retry Behavior", () => {
    it("should identify 5xx status codes as retryable", () => {
      fc.assert(
        fc.property(
          // Generate 5xx status codes
          fc.integer({ min: 500, max: 599 }),
          (statusCode) => {
            return shouldRetry(statusCode) === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should not retry on non-5xx status codes", () => {
      fc.assert(
        fc.property(
          // Generate non-5xx status codes (1xx, 2xx, 3xx, 4xx)
          fc.oneof(
            fc.integer({ min: 100, max: 199 }),
            fc.integer({ min: 200, max: 299 }),
            fc.integer({ min: 300, max: 399 }),
            fc.integer({ min: 400, max: 499 })
          ),
          (statusCode) => {
            return shouldRetry(statusCode) === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 5: Exponential Backoff Calculation
   * For any retry attempt N (where N is 0, 1, or 2), the retry delay SHALL be
   * calculated as `baseDelay * 2^N + jitter` where jitter is a random value
   * between 0 and 500ms.
   *
   * **Validates: Requirements 4.3**
   */
  describe("Property 5: Exponential Backoff Calculation", () => {
    it("should calculate delay as baseDelay * 2^attempt plus jitter", () => {
      fc.assert(
        fc.property(
          // Generate attempt numbers (0, 1, 2)
          fc.integer({ min: 0, max: 2 }),
          // Generate base delay values
          fc.integer({ min: 100, max: 5000 }),
          // Generate jitter max values
          fc.integer({ min: 0, max: 1000 }),
          (attempt, baseDelay, jitterMax) => {
            const config = {
              ...DEFAULT_RETRY_CONFIG,
              baseDelay,
              jitterMax,
              maxDelay: 100000, // High max to not interfere
            };

            const delay = calculateBackoffDelay(attempt, config);
            const expectedBase = baseDelay * Math.pow(2, attempt);

            // Delay should be >= expectedBase (base without jitter)
            // and <= expectedBase + jitterMax (base with max jitter)
            return delay >= expectedBase && delay <= expectedBase + jitterMax;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should respect maxDelay cap", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 1000, max: 5000 }),
          (attempt, maxDelay) => {
            const config = {
              ...DEFAULT_RETRY_CONFIG,
              baseDelay: 1000,
              maxDelay,
              jitterMax: 500,
            };

            const delay = calculateBackoffDelay(attempt, config);

            // Delay should never exceed maxDelay
            return delay <= maxDelay;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should produce increasing delays for sequential attempts", () => {
      // Test with fixed jitter (0) to verify exponential growth
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 1000,
        jitterMax: 0, // No jitter for deterministic test
        maxDelay: 100000,
      };

      const delay0 = calculateBackoffDelay(0, config);
      const delay1 = calculateBackoffDelay(1, config);
      const delay2 = calculateBackoffDelay(2, config);

      // 1000 * 2^0 = 1000
      expect(delay0).toBe(1000);
      // 1000 * 2^1 = 2000
      expect(delay1).toBe(2000);
      // 1000 * 2^2 = 4000
      expect(delay2).toBe(4000);
    });
  });


  /**
   * Property 6: 4xx No-Retry Behavior
   * For any HTTP response with a status code in the range 400-499, the
   * HTTP_Client SHALL NOT retry the request and SHALL immediately return
   * the error.
   *
   * **Validates: Requirements 4.5**
   */
  describe("Property 6: 4xx No-Retry Behavior", () => {
    it("should not retry on 4xx status codes", () => {
      fc.assert(
        fc.property(
          // Generate 4xx status codes
          fc.integer({ min: 400, max: 499 }),
          (statusCode) => {
            // shouldRetry should return false for all 4xx codes
            return shouldRetry(statusCode) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should distinguish between 4xx and 5xx status codes", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 400, max: 599 }),
          (statusCode) => {
            const shouldRetryResult = shouldRetry(statusCode);

            if (statusCode >= 400 && statusCode < 500) {
              // 4xx should NOT retry
              return shouldRetryResult === false;
            } else {
              // 5xx should retry
              return shouldRetryResult === true;
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("TimeoutError", () => {
    it("should include endpoint and duration in error", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.integer({ min: 1, max: 300000 }),
          (endpoint, duration) => {
            const error = new TimeoutError(endpoint, duration);

            return (
              error.endpoint === endpoint &&
              error.duration === duration &&
              error.message.includes(endpoint) &&
              error.message.includes(String(duration)) &&
              error.name === "TimeoutError"
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
