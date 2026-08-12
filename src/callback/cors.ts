/**
 * The origin check on the loopback callback server (R4.1, R4.2).
 *
 * This CONSTRAINS the callback; it does not AUTHENTICATE it. A local process
 * that sets `Origin: https://21st.dev` still qualifies, because authenticating
 * the callback needs a secret echoed by a page at `21st.dev` that this project
 * does not control (story.md Assumption 3, design.md Fix Approach 4). What is
 * closed here is narrower and real: a request that sends NO origin, and an
 * arbitrary loopback page, no longer answer a callback meant for the browser we
 * opened.
 */

/**
 * Loopback origins, admitted only when explicitly opted in.
 *
 * A page on the user's own dev server — possibly running third-party
 * JavaScript — is not the issuing service, so this is development scaffolding
 * for this project rather than part of the product's flow.
 */
const LOCALHOST_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
];

/**
 * The issuing service and its subdomains. Anchored at both ends, so
 * `21st.dev.evil.com` and `evil21st.dev` are refused; measured correct and
 * deliberately left byte-for-byte unchanged by this sub-task.
 */
const TWENTY_FIRST_DEV_PATTERN =
  /^https?:\/\/([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*21st\.dev(:\d+)?$/;

/**
 * The single string every decision here is made on, and the only one ever
 * echoed back.
 *
 * Defined once because the two must not drift: without the `m` flag, `$` also
 * matches before a trailing newline, so a value that was matched raw could put
 * a newline into a response header. Trimming first makes that unrepresentable.
 * An absent origin normalizes to `""`, which no pattern accepts.
 */
function normalizeOrigin(origin: string | undefined): string {
  return origin?.trim() ?? "";
}

/** How far past the issuing service the check is allowed to reach. */
export interface OriginCheckOptions {
  /**
   * Admit loopback origins (`localhost`, `127.0.0.1`, `[::1]`, any port).
   *
   * Opt-in, never a default: it widens the set of pages that can answer a
   * callback to every page the machine happens to be serving.
   */
  readonly allowLocalhost?: boolean;
}

export class CorsHandler {
  /**
   * An ABSENT origin is refused, not admitted. A browser always sends `Origin`
   * on a cross-origin POST, so the legitimate page is unaffected — and a
   * request without one is not that page.
   *
   * The two decisions are independent: opting localhost in does not widen
   * anything else, and the issuing origin being allowed never admits localhost.
   */
  static isAllowedOrigin(origin: string | undefined, options?: OriginCheckOptions): boolean {
    const trimmed = normalizeOrigin(origin);
    if (trimmed === "") return false;

    if (options?.allowLocalhost === true) {
      for (const pattern of LOCALHOST_PATTERNS) {
        if (pattern.test(trimmed)) return true;
      }
    }

    return TWENTY_FIRST_DEV_PATTERN.test(trimmed);
  }

  /**
   * A refused origin gets NO `Access-Control-Allow-Origin` header at all — not
   * `"*"`, which is what an originless request used to receive, and which is a
   * grant to every page on the machine.
   *
   * What is echoed is exactly what was checked — one `normalizeOrigin` value
   * used for both, so the grant can never name a string the check never saw.
   */
  static getCorsHeaders(
    origin: string | undefined,
    options?: OriginCheckOptions
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    const checked = normalizeOrigin(origin);
    if (this.isAllowedOrigin(checked, options)) {
      headers["Access-Control-Allow-Origin"] = checked;
    }

    return headers;
  }
}
