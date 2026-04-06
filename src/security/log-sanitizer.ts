const REDACTED = "[REDACTED]";

const DEFAULT_PATTERNS: RegExp[] = [
  /(?<=^|[\s=:])(?:sk|pk|api|key|secret|token|auth|bearer)[_-][A-Za-z0-9_-]{16,}/gi,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b[a-f0-9]{64,}\b/gi,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
];

const SENSITIVE_PARAMS: string[] = [
  "key", "token", "secret", "password", "api_key", "apikey",
];

const SENSITIVE_HEADERS: string[] = [
  "x-api-key", "authorization", "cookie",
];

export class LogSanitizer {
  static sanitize(input: string): string {
    if (!input || typeof input !== "string") return input;

    let result = input;
    for (const pattern of DEFAULT_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }
    return result;
  }

  static sanitizeUrl(url: string): string {
    if (!url || typeof url !== "string") return url;

    try {
      const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url);
      const urlObj = hasProtocol ? new URL(url) : new URL(url, "http://dummy");

      let modified = false;
      for (const [key] of urlObj.searchParams) {
        if (SENSITIVE_PARAMS.includes(key.toLowerCase())) {
          urlObj.searchParams.set(key, REDACTED);
          modified = true;
        }
      }

      if (!modified) return url;
      return hasProtocol ? urlObj.toString() : urlObj.toString().replace("http://dummy", "");
    } catch {
      return LogSanitizer.sanitizeUrlFallback(url);
    }
  }

  private static sanitizeUrlFallback(url: string): string {
    let result = url;
    for (const param of SENSITIVE_PARAMS) {
      const regex = new RegExp(`([?&])${param}=([^&]*)`, "gi");
      result = result.replace(regex, `$1${param}=${REDACTED}`);
    }
    return result;
  }

  static sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    if (!headers || typeof headers !== "object") return headers;

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      result[key] = SENSITIVE_HEADERS.includes(key.toLowerCase()) ? REDACTED : value;
    }
    return result;
  }
}
