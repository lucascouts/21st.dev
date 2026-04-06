const LOCALHOST_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
];

const TWENTY_FIRST_DEV_PATTERN =
  /^https?:\/\/([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*21st\.dev(:\d+)?$/;

export class CorsHandler {
  static isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin || origin.trim() === "") return true;

    const trimmed = origin.trim();

    for (const pattern of LOCALHOST_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }

    if (TWENTY_FIRST_DEV_PATTERN.test(trimmed)) return true;

    return false;
  }

  static getCorsHeaders(origin: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (this.isAllowedOrigin(origin)) {
      headers["Access-Control-Allow-Origin"] = origin || "*";
    }

    return headers;
  }
}
