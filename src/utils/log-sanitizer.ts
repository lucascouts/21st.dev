/**
 * Log Sanitizer utility for redacting sensitive data from logs.
 * Prevents credentials and API keys from being exposed in log files.
 *
 * Requirements: A3.1, A3.2, A3.3, A3.4
 */

export interface SanitizeOptions {
  patterns?: RegExp[];
  sensitiveParams?: string[];
  sensitiveHeaders?: string[];
}

const REDACTED = "[REDACTED]";

export class LogSanitizer {
  /**
   * Default pattern for API keys (20+ alphanumeric chars with underscores/dashes)
   * Requirement A3.1
   */
  private static readonly DEFAULT_PATTERNS: RegExp[] = [
    /[A-Za-z0-9_-]{20,}/g,
  ];

  /**
   * Sensitive query parameter names to redact
   * Requirement A3.2
   */
  private static readonly SENSITIVE_PARAMS: string[] = [
    "key",
    "token",
    "secret",
    "password",
    "api_key",
    "apikey",
  ];

  /**
   * Sensitive header names to redact (case-insensitive)
   * Requirement A3.3
   */
  private static readonly SENSITIVE_HEADERS: string[] = [
    "x-api-key",
    "authorization",
    "cookie",
  ];

  /**
   * Sanitize a string by redacting sensitive data matching API key patterns.
   * Replaces matches with [REDACTED].
   *
   * Requirement A3.1, A3.4
   */
  static sanitize(input: string, options?: SanitizeOptions): string {
    if (!input || typeof input !== "string") {
      return input;
    }

    const patterns = options?.patterns ?? LogSanitizer.DEFAULT_PATTERNS;
    let result = input;

    for (const pattern of patterns) {
      // Create a new RegExp to reset lastIndex for global patterns
      const regex = new RegExp(pattern.source, pattern.flags);
      result = result.replace(regex, REDACTED);
    }

    return result;
  }

  /**
   * Sanitize a URL by redacting sensitive query parameters.
   * Replaces values of sensitive params with [REDACTED].
   *
   * Requirement A3.2, A3.4
   */
  static sanitizeUrl(url: string): string {
    if (!url || typeof url !== "string") {
      return url;
    }

    try {
      const sensitiveParams =
        LogSanitizer.SENSITIVE_PARAMS.map((p) => p.toLowerCase());

      // Handle both full URLs and relative URLs with query strings
      const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url);
      const urlObj = hasProtocol ? new URL(url) : new URL(url, "http://dummy");

      let modified = false;
      for (const [key] of urlObj.searchParams) {
        if (sensitiveParams.includes(key.toLowerCase())) {
          urlObj.searchParams.set(key, REDACTED);
          modified = true;
        }
      }

      if (!modified) {
        return url;
      }

      // Return the sanitized URL, removing dummy base if it was added
      return hasProtocol ? urlObj.toString() : urlObj.toString().replace("http://dummy", "");
    } catch {
      // If URL parsing fails, fall back to regex-based sanitization
      return LogSanitizer.sanitizeUrlFallback(url);
    }
  }

  /**
   * Fallback URL sanitization using regex for malformed URLs
   */
  private static sanitizeUrlFallback(url: string): string {
    const sensitiveParams = LogSanitizer.SENSITIVE_PARAMS;
    let result = url;

    for (const param of sensitiveParams) {
      // Match param=value patterns (case-insensitive for param name)
      const regex = new RegExp(
        `([?&])${param}=([^&]*)`,
        "gi"
      );
      result = result.replace(regex, `$1${param}=${REDACTED}`);
    }

    return result;
  }

  /**
   * Sanitize headers object by redacting sensitive header values.
   * Returns a new object with redacted values.
   *
   * Requirement A3.3, A3.4
   */
  static sanitizeHeaders(
    headers: Record<string, string>
  ): Record<string, string> {
    if (!headers || typeof headers !== "object") {
      return headers;
    }

    const sensitiveHeaders =
      LogSanitizer.SENSITIVE_HEADERS.map((h) => h.toLowerCase());
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
