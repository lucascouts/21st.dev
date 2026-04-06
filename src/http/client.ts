import type { Logger } from "../logger.js";

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitterMax: number;
}

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout: number;
  retry: RetryConfig;
  logger: Logger;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  ok: boolean;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("etimedout")
    );
  }
  return false;
}

function calculateBackoff(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * config.jitterMax;
  return Math.min(delay + jitter, config.maxDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly retry: RetryConfig;
  private readonly logger: Logger;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeout = config.timeout;
    this.retry = config.retry;
    this.logger = config.logger;
  }

  async get<T>(endpoint: string): Promise<HttpResponse<T>> {
    return this.request<T>("GET", endpoint);
  }

  async post<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>("POST", endpoint, body);
  }

  async put<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>("PUT", endpoint, body);
  }

  async delete<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>("DELETE", endpoint, body);
  }

  async patch<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>("PATCH", endpoint, body);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError: Error | null = null;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        this.logger.debug(`HTTP ${method} ${url} (attempt ${attempt + 1})`);

        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          signal: controller.signal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });

        // 4xx — no retry
        if (response.status >= 400 && response.status < 500) {
          const data = await this.safeJson<T>(response);
          return { status: response.status, data, ok: false };
        }

        // 5xx — retry
        if (response.status >= 500) {
          lastResponse = response;
          if (attempt < this.retry.maxRetries) {
            const delay = calculateBackoff(attempt, this.retry);
            this.logger.warn(
              `${endpoint} returned ${response.status}, retrying in ${Math.round(delay)}ms (${attempt + 1}/${this.retry.maxRetries})`
            );
            await sleep(delay);
            continue;
          }
          const data = await this.safeJson<T>(response);
          return { status: response.status, data, ok: false };
        }

        // Success
        const data = await this.safeJson<T>(response);
        return { status: response.status, data, ok: true };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Timeout — no retry
        if (lastError.name === "AbortError") {
          return {
            status: 0,
            data: null as T,
            ok: false,
          };
        }

        // Network error — retry
        if (isNetworkError(error) && attempt < this.retry.maxRetries) {
          const delay = calculateBackoff(attempt, this.retry);
          this.logger.warn(
            `Network error for ${endpoint}: ${lastError.message}, retrying in ${Math.round(delay)}ms (${attempt + 1}/${this.retry.maxRetries})`
          );
          await sleep(delay);
          continue;
        }

        return {
          status: 0,
          data: null as T,
          ok: false,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Exhausted retries
    if (lastResponse) {
      const data = await this.safeJson<T>(lastResponse);
      return { status: lastResponse.status, data, ok: false };
    }

    return { status: 0, data: null as T, ok: false };
  }

  private async safeJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      return null as T;
    }
  }
}
