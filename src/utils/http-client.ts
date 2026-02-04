import { config } from "./config.js";
import { logger } from "./logger.js";

const TWENTY_FIRST_API_KEY =
  config.apiKey || process.env.TWENTY_FIRST_API_KEY || process.env.API_KEY;

const isTesting = process.env.DEBUG === "true" ? true : false;
export const BASE_URL = isTesting
  ? "http://localhost:3005"
  : "https://magic.21st.dev";

/**
 * Default timeout in milliseconds (30 seconds)
 * Can be overridden via TWENTY_FIRST_TIMEOUT environment variable
 * Requirements: 3.1, 3.2
 */
export const DEFAULT_TIMEOUT = 30000;

/**
 * Get configured timeout from environment or use default
 * Requirements: 3.2
 */
export function getTimeout(): number {
  const envTimeout = process.env.TWENTY_FIRST_TIMEOUT;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TIMEOUT;
}

/**
 * Retry configuration
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitterMax: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 8000,
  jitterMax: 500,
};

/**
 * Calculate exponential backoff delay with jitter
 * Formula: baseDelay * 2^attempt + random(0, jitterMax)
 * Requirements: 4.3
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * config.jitterMax;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}


/**
 * Custom error class for timeout errors
 * Requirements: 3.3, 3.4
 */
export class TimeoutError extends Error {
  public readonly endpoint: string;
  public readonly duration: number;

  constructor(endpoint: string, duration: number) {
    super(`Request to ${endpoint} timed out after ${duration}ms`);
    this.name = "TimeoutError";
    this.endpoint = endpoint;
    this.duration = duration;
  }
}

/**
 * Check if an error is a network error that should be retried
 * Requirements: 4.2
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // fetch throws TypeError for network failures
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("etimedout")
    );
  }
  return false;
}

/**
 * Check if a status code should trigger a retry
 * Requirements: 4.1, 4.5
 */
export function shouldRetry(status: number): boolean {
  // Retry on 5xx errors only, not on 4xx
  return status >= 500 && status < 600;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface HttpClient {
  get<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<{ status: number; data: T }>;
  post<T>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<{ status: number; data: T }>;
  put<T>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<{ status: number; data: T }>;
  delete<T>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<{ status: number; data: T }>;
  patch<T>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<{ status: number; data: T }>;
}

/**
 * Execute a fetch request with retry logic
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */
async function executeWithRetry<T>(
  fetchFn: () => Promise<Response>,
  endpoint: string,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<Response> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const response = await fetchFn();

      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        logger.debug(`Request to ${endpoint} returned ${response.status}, not retrying (4xx)`);
        return response;
      }

      // Retry on 5xx errors
      if (shouldRetry(response.status)) {
        lastResponse = response;
        if (attempt < retryConfig.maxRetries) {
          const delay = calculateBackoffDelay(attempt, retryConfig);
          logger.warn(
            `Request to ${endpoint} returned ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retryConfig.maxRetries})`
          );
          await sleep(delay);
          continue;
        }
        // All retries exhausted, return the last response
        logger.error(`Request to ${endpoint} failed after ${retryConfig.maxRetries} retries`);
        return response;
      }

      // Success
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Retry on network errors
      if (isNetworkError(error) && attempt < retryConfig.maxRetries) {
        const delay = calculateBackoffDelay(attempt, retryConfig);
        logger.warn(
          `Network error for ${endpoint}: ${lastError.message}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retryConfig.maxRetries})`
        );
        await sleep(delay);
        continue;
      }

      // Don't retry timeout errors or non-network errors
      throw lastError;
    }
  }

  // Should not reach here, but handle edge case
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError || new Error("Unknown error during request");
}


const createMethod = (method: HttpMethod) => {
  return async <T>(
    endpoint: string,
    data?: unknown,
    options: RequestInit = {}
  ) => {
    const timeout = getTimeout();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...(TWENTY_FIRST_API_KEY ? { "x-api-key": TWENTY_FIRST_API_KEY } : {}),
      ...options.headers,
    };

    const url = `${BASE_URL}${endpoint}`;
    logger.debug(`HTTP ${method} ${url}`);

    try {
      const response = await executeWithRetry(
        () =>
          fetch(url, {
            ...options,
            method,
            headers,
            signal: controller.signal,
            // Enable HTTP keep-alive for connection reuse
            // Requirements: 10.1
            keepalive: true,
            ...(data ? { body: JSON.stringify(data) } : {}),
          }),
        endpoint
      );

      logger.debug(`Response from ${endpoint}: ${response.status}`);
      return { status: response.status, data: (await response.json()) as T };
    } catch (error) {
      // Handle abort (timeout) errors
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError(endpoint, timeout);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };
};

export const twentyFirstClient: HttpClient = {
  get: createMethod("GET"),
  post: createMethod("POST"),
  put: createMethod("PUT"),
  delete: createMethod("DELETE"),
  patch: createMethod("PATCH"),
};
