/**
 * Shell Sanitizer - Sanitizes inputs before shell command execution
 * Implements security rules per Requirements 7.1, 7.2, 7.3
 */

/**
 * Shell metacharacters that must be escaped to prevent command injection
 */
export const SHELL_METACHARACTERS = [
  ";",   // Command separator
  "&",   // Background/AND operator
  "|",   // Pipe operator
  ">",   // Output redirection
  "<",   // Input redirection
  "`",   // Command substitution (backtick)
  "$",   // Variable expansion / command substitution
  "(",   // Subshell start
  ")",   // Subshell end
  "'",   // Single quote
  '"',   // Double quote
  "\\",  // Escape character
  "*",   // Glob wildcard
  "?",   // Glob single char
  "[",   // Glob character class start
  "]",   // Glob character class end
  "!",   // History expansion / negation
  "#",   // Comment
  "~",   // Home directory expansion
  "^",   // History substitution
  "\n",  // Newline (command separator)
  "\r",  // Carriage return
] as const;

export interface SanitizeUrlOptions {
  allowedProtocols?: string[];
}

/**
 * Shell Sanitizer class for preventing command injection attacks
 */
export class ShellSanitizer {
  private static readonly DEFAULT_ALLOWED_PROTOCOLS = ["http:", "https:"];

  /**
   * Escape shell metacharacters in a string
   * Wraps the argument in single quotes and escapes any single quotes within
   * 
   * @param arg - The argument to escape
   * @returns The escaped argument safe for shell use
   */
  static escapeShellArg(arg: string): string {
    if (arg === "") {
      return "''";
    }

    // The safest way to escape shell arguments is to wrap in single quotes
    // and escape any single quotes by ending the quote, adding escaped quote, and reopening
    // e.g., "it's" becomes 'it'\''s'
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  /**
   * Validate and sanitize a URL for browser opening
   * Only allows http:// and https:// protocols by default
   * 
   * @param url - The URL to validate and sanitize
   * @param options - Optional configuration for allowed protocols
   * @returns The sanitized URL
   * @throws Error if URL is invalid or uses disallowed protocol
   */
  static sanitizeUrl(url: string, options?: SanitizeUrlOptions): string {
    if (!url || typeof url !== "string") {
      throw new Error("URL must be a non-empty string");
    }

    const trimmedUrl = url.trim();
    if (trimmedUrl === "") {
      throw new Error("URL cannot be empty");
    }

    // Parse the URL to validate structure
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error(`Invalid URL format: ${trimmedUrl}`);
    }

    // Validate protocol
    const allowedProtocols = options?.allowedProtocols ?? this.DEFAULT_ALLOWED_PROTOCOLS;
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      throw new Error(
        `Invalid URL protocol: ${parsedUrl.protocol}. Allowed protocols: ${allowedProtocols.join(", ")}`
      );
    }

    // URL-encode any shell metacharacters in the path and query string
    // The URL constructor already handles most encoding, but we need to ensure
    // shell metacharacters are properly encoded
    const encodedUrl = this.encodeShellMetacharsInUrl(parsedUrl);

    return encodedUrl;
  }

  /**
   * Check if a string contains dangerous shell metacharacters
   * 
   * @param str - The string to check
   * @returns true if the string contains shell metacharacters
   */
  static containsShellMetachars(str: string): boolean {
    if (!str || typeof str !== "string") {
      return false;
    }

    for (const char of SHELL_METACHARACTERS) {
      if (str.includes(char)) {
        return true;
      }
    }

    return false;
  }

  /**
   * URL-encode shell metacharacters in URL path and query components
   * 
   * @param parsedUrl - The parsed URL object
   * @returns The URL string with shell metacharacters encoded
   */
  private static encodeShellMetacharsInUrl(parsedUrl: URL): string {
    // Characters that need additional encoding for shell safety
    // Note: URL constructor already encodes many special chars, but some may slip through
    // IMPORTANT: Do NOT encode ? and & as they are valid URL query string delimiters
    // Shell injection is prevented by using spawn() with array arguments instead of shell execution
    const shellCharsToEncode: Record<string, string> = {
      "'": "%27",
      '"': "%22",
      "`": "%60",
      "$": "%24",
      "\\": "%5C",
      "!": "%21",
      "#": "%23",  // Fragment delimiter, but also shell comment
      "^": "%5E",
      "|": "%7C",
      ";": "%3B",
      "(": "%28",
      ")": "%29",
      "<": "%3C",
      ">": "%3E",
      "*": "%2A",
      "[": "%5B",
      "]": "%5D",
      "~": "%7E",
    };

    // Get the href and manually encode any remaining shell metacharacters
    let result = parsedUrl.href;

    // Only encode in the path and query portions (after the host)
    const protocolAndHost = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const pathAndQuery = result.slice(protocolAndHost.length);

    let encodedPathAndQuery = pathAndQuery;
    for (const [char, encoded] of Object.entries(shellCharsToEncode)) {
      // Use a regex to replace all occurrences
      encodedPathAndQuery = encodedPathAndQuery.split(char).join(encoded);
    }

    return protocolAndHost + encodedPathAndQuery;
  }
}
