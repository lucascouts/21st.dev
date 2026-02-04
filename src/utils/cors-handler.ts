/**
 * CORS Handler - Validates request origins for the callback server
 * Implements security rules per Requirements 5.1, 5.2, 5.3, 5.4
 */

/**
 * Allowed origins for CORS validation
 * Includes localhost variations and 21st.dev domains
 */
export const ALLOWED_ORIGINS: (string | RegExp)[] = [
  // Localhost variations (Requirement 5.1)
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://[::1]",
  "https://[::1]",
  // 21st.dev domains (Requirement 5.2)
  "http://21st.dev",
  "https://21st.dev",
  // Subdomains of 21st.dev
  /^https?:\/\/[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.21st\.dev$/,
];

/**
 * Localhost patterns for quick matching
 */
const LOCALHOST_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
];

/**
 * 21st.dev pattern for subdomain matching (supports multi-level subdomains)
 */
const TWENTY_FIRST_DEV_PATTERN = /^https?:\/\/([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*21st\.dev(:\d+)?$/;

/**
 * CORS Handler class for validating request origins
 */
export class CorsHandler {
  /**
   * Check if an origin is allowed
   * 
   * @param origin - The Origin header value from the request
   * @returns true if the origin is allowed, false otherwise
   */
  static isAllowedOrigin(origin: string | undefined): boolean {
    // No origin header - allow (same-origin requests)
    if (!origin) {
      return true;
    }

    const trimmedOrigin = origin.trim();
    if (trimmedOrigin === "") {
      return true;
    }

    // Check localhost patterns (Requirement 5.1)
    for (const pattern of LOCALHOST_PATTERNS) {
      if (pattern.test(trimmedOrigin)) {
        return true;
      }
    }

    // Check 21st.dev and subdomains (Requirement 5.2)
    if (TWENTY_FIRST_DEV_PATTERN.test(trimmedOrigin)) {
      return true;
    }

    // Origin not allowed (Requirement 5.3)
    return false;
  }

  /**
   * Get CORS headers for a response
   * Returns appropriate headers based on whether the origin is allowed
   * 
   * @param origin - The Origin header value from the request
   * @returns Record of CORS headers to set on the response
   */
  static getCorsHeaders(origin: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400", // 24 hours
    };

    // Only include Access-Control-Allow-Origin for allowed origins (Requirement 5.4)
    if (this.isAllowedOrigin(origin)) {
      // Return the specific origin instead of wildcard for security
      headers["Access-Control-Allow-Origin"] = origin || "*";
    }

    return headers;
  }
}
