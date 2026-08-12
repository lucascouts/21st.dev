/**
 * The origin check on the loopback callback (R4.1, R4.2 — task 3.1).
 *
 * WHAT IS PINNED
 * --------------
 * 1. **Absence is not permission.** `isAllowedOrigin(undefined)` returns `true`
 *    today, which admits every non-browser process on the machine: a browser
 *    always sends `Origin` on a cross-origin POST, so a request without one is
 *    not the page we sent the user to. Measured 2026-08-12: absent, `""`,
 *    `"   "` are all accepted.
 * 2. **An arbitrary loopback origin is not the issuing service.** Every
 *    `http://localhost:<port>` is accepted today, including a page served by the
 *    user's own dev server running third-party JavaScript. It becomes opt-in.
 * 3. **The legitimate path still works.** Every assertion that tightens the
 *    check is paired with one that the issuing origin is still ACCEPTED, and
 *    that the response still carries its `Access-Control-Allow-Origin`. A
 *    tightening that also refuses `https://21st.dev` would pass a file that only
 *    listed refusals; this file cannot be satisfied that way.
 * 4. **The host regex is unchanged.** `21st.dev.evil.com`, `evil21st.dev` and
 *    the literal `"null"` are refused today because the pattern is correctly
 *    anchored. They are asserted here so that "tighten the origin check" cannot
 *    quietly become "rewrite the pattern".
 *
 * WHAT IS DELIBERATELY NOT PINNED
 * -------------------------------
 * - **Plain-`http` 21st.dev.** `http://21st.dev` is accepted today and this file
 *   says nothing about it: design.md changes the absent-origin line and the
 *   localhost entries only, and the pattern's scheme alternation is part of the
 *   pattern that is explicitly left alone.
 * - **The shape of the opt-in.** design.md says the localhost allowlist becomes
 *   "opt-in through configuration" without fixing the parameter's form, so
 *   `allowsLocalhostWhenOptedIn` below accepts either an options object or a
 *   boolean flag. It asserts the BEHAVIOUR — opted in, localhost is admitted —
 *   not the calling convention.
 *
 * NOT AUTHENTICATION, AND THIS FILE DOES NOT CLAIM IT IS. A local process that
 * sets `Origin: https://21st.dev` still qualifies (story.md Assumption 3); a
 * nonce needs a change at a service this project does not control. There is
 * therefore no assertion here that a callback is authenticated, because it
 * is not.
 *
 * No test in this file performs any I/O.
 */
import { describe, it, expect } from "bun:test";
import { CorsHandler } from "../../callback/cors.js";

/** The header a browser sends, and the only value this class reads. */
const ACAO = "Access-Control-Allow-Origin";

/** Origins the issuing service really uses. These must stay ACCEPTED. */
const ISSUING_ORIGINS: readonly string[] = [
  "https://21st.dev",
  "https://magic.21st.dev",
  "https://www.21st.dev",
];

/**
 * An absent `Origin` and its whitespace-only spellings. `undefined` is what a
 * plain loopback POST produces — the measured path by which a non-browser
 * process answered a callback meant for the user's browser.
 */
const ORIGINLESS: readonly (string | undefined)[] = [undefined, "", "   ", "\t"];

/** Loopback pages: refused by default, admitted only when opted in. */
const LOCALHOST_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://localhost",
  "http://127.0.0.1:5173",
  "http://[::1]:8080",
];

/**
 * Near misses the anchored pattern already refuses. Asserted so a rewrite of the
 * pattern cannot pass unnoticed while "the origin check was tightened".
 */
const NEAR_MISSES: readonly string[] = [
  "https://evil.com",
  "https://21st.dev.evil.com",
  "https://evil21st.dev",
  "http://evil21st.dev",
  "https://21st.dev.attacker.io",
  "null",
];

/**
 * The localhost opt-in, called without pinning its calling convention.
 *
 * Either shape satisfies this: an options object (`{ allowLocalhost: true }`)
 * or a positional boolean. Both are attempted and the results OR-ed, so the
 * assertion is about the admitted origin and not about the signature that
 * admits it.
 */
type OptInCheck = (origin: string | undefined, optIn?: unknown) => boolean;

function allowsLocalhostWhenOptedIn(origin: string): boolean {
  const check = CorsHandler.isAllowedOrigin as unknown as OptInCheck;
  return check(origin, { allowLocalhost: true }) || check(origin, true);
}

describe("CorsHandler.isAllowedOrigin", () => {
  for (const origin of ORIGINLESS) {
    it(`refuses a request whose Origin is ${JSON.stringify(origin)}`, () => {
      expect(CorsHandler.isAllowedOrigin(origin)).toBe(false);
    });
  }

  for (const origin of ISSUING_ORIGINS) {
    it(`still accepts the issuing origin ${origin}`, () => {
      expect(CorsHandler.isAllowedOrigin(origin)).toBe(true);
    });
  }

  for (const origin of LOCALHOST_ORIGINS) {
    it(`refuses ${origin} by default`, () => {
      expect(CorsHandler.isAllowedOrigin(origin)).toBe(false);
    });

    it(`accepts ${origin} when localhost is opted in`, () => {
      expect(allowsLocalhostWhenOptedIn(origin)).toBe(true);
    });
  }

  for (const origin of NEAR_MISSES) {
    it(`still refuses ${JSON.stringify(origin)}`, () => {
      expect(CorsHandler.isAllowedOrigin(origin)).toBe(false);
    });
  }

  it("does not admit a localhost origin merely because the issuing origin is allowed", () => {
    // The two decisions are independent: opting localhost in must not be a
    // side effect of the issuing origin being allowed, and vice versa.
    expect(CorsHandler.isAllowedOrigin("https://21st.dev")).toBe(true);
    expect(CorsHandler.isAllowedOrigin("http://localhost:3000")).toBe(false);
  });
});

describe("CorsHandler.getCorsHeaders", () => {
  it("emits no Access-Control-Allow-Origin for a request with no Origin", () => {
    // `"*"` is emitted today. The assertion is on the header's ABSENCE rather
    // than on its value, because any value at all is a grant.
    expect(Object.keys(CorsHandler.getCorsHeaders(undefined))).not.toContain(ACAO);
  });

  it("emits no Access-Control-Allow-Origin for an arbitrary localhost origin", () => {
    expect(Object.keys(CorsHandler.getCorsHeaders("http://localhost:3000"))).not.toContain(ACAO);
  });

  it("echoes the issuing origin back, so the legitimate page is unaffected", () => {
    // The control for both assertions above: the header must still be emitted
    // for the origin the flow actually uses, and must echo it rather than `*`.
    const headers = CorsHandler.getCorsHeaders("https://21st.dev");
    expect(headers[ACAO]).toBe("https://21st.dev");
  });

  it("keeps the method and header allowances it already emits", () => {
    // Unchanged behaviour: these are not part of the tightening.
    const headers = CorsHandler.getCorsHeaders("https://21st.dev");
    expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
    expect(headers["Access-Control-Allow-Headers"]).toBe("Content-Type");
  });
});
