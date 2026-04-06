export const SHELL_METACHARACTERS = [
  ";", "&", "|", ">", "<", "`", "$", "(", ")", "'", '"', "\\",
  "*", "?", "[", "]", "!", "#", "~", "^", "\n", "\r",
] as const;

export interface SanitizeUrlOptions {
  allowedProtocols?: string[];
}

export class ShellSanitizer {
  private static readonly DEFAULT_ALLOWED_PROTOCOLS = ["http:", "https:"];

  static escapeShellArg(arg: string): string {
    if (arg === "") return "''";
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  static sanitizeUrl(url: string, options?: SanitizeUrlOptions): string {
    if (!url || typeof url !== "string") {
      throw new Error("URL must be a non-empty string");
    }

    const trimmedUrl = url.trim();
    if (trimmedUrl === "") {
      throw new Error("URL cannot be empty");
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error(`Invalid URL format: ${trimmedUrl}`);
    }

    const allowedProtocols = options?.allowedProtocols ?? this.DEFAULT_ALLOWED_PROTOCOLS;
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      throw new Error(
        `Invalid URL protocol: ${parsedUrl.protocol}. Allowed protocols: ${allowedProtocols.join(", ")}`
      );
    }

    return this.encodeShellMetacharsInUrl(parsedUrl);
  }

  static containsShellMetachars(str: string): boolean {
    if (!str || typeof str !== "string") return false;
    for (const char of SHELL_METACHARACTERS) {
      if (str.includes(char)) return true;
    }
    return false;
  }

  private static encodeShellMetacharsInUrl(parsedUrl: URL): string {
    const shellCharsToEncode: Record<string, string> = {
      "'": "%27", '"': "%22", "`": "%60", "$": "%24", "\\": "%5C",
      "!": "%21", "#": "%23", "^": "%5E", "|": "%7C", ";": "%3B",
      "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", "*": "%2A",
      "[": "%5B", "]": "%5D", "~": "%7E",
    };

    let result = parsedUrl.href;
    const protocolAndHost = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const pathAndQuery = result.slice(protocolAndHost.length);

    let encodedPathAndQuery = pathAndQuery;
    for (const [char, encoded] of Object.entries(shellCharsToEncode)) {
      encodedPathAndQuery = encodedPathAndQuery.split(char).join(encoded);
    }

    return protocolAndHost + encodedPathAndQuery;
  }
}
