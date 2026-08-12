import { describe, it, expect } from "bun:test";
import { sanitizeSvg } from "../../security/svg-sanitizer.js";

/**
 * Contract under test (story 005, R1 and R4.1):
 *
 *   export async function sanitizeSvg(raw: string): Promise<string>
 *
 * The function parses the markup, emits only allowlisted elements and attributes,
 * constrains URI values, and is total: every input returns a string and no path
 * raises. A parser failure returns empty output, never the input.
 *
 * This file carries three bodies of coverage:
 *   1. the 14 bypasses measured against the shipped regex sanitizer on 2026-08-11
 *      (story.md "Reproduction Steps"), one assertion per payload, plus the three
 *      payloads added during design (design.md "Fix Approach 1": 17 total);
 *   2. the positional cases from design.md GOTCHA 3 — the case a green payload
 *      suite did not catch;
 *   3. the 11 assertions absorbed verbatim by name from
 *      src/__tests__/http/svg-sanitizer.test.ts, so deleting that file in task 1.2
 *      removes an implementation and not coverage.
 *
 * No test here reaches the network: every input is a literal fixture.
 */

/** Whitespace-insensitive, case-insensitive view of the output. */
function collapse(markup: string): string {
  return markup.replace(/\s+/g, "").toLowerCase();
}

const REJECTED_ELEMENT_PATTERN =
  /<(script|style|foreignobject|animate|animatetransform|set|image|iframe|embed|object|a)\b/i;

/** Every LIVE tag in the output. Escaped text (`&lt;img …&gt;`) yields none. */
function liveTags(markup: string): readonly string[] {
  return markup.match(/<[a-zA-Z/!][^>]*>/g) ?? [];
}

/**
 * Invariants that must hold for the output of every hostile payload, whatever
 * the payload was. Applied on top of the per-payload assertion so a bypass that
 * mutates into a different construct is still caught.
 *
 * The handler and scheme checks are scoped to LIVE markup deliberately: text the
 * sanitizer escaped is inert in every consumer of this output — as raw SVG, and
 * as the JSX/TSX that `logo-search.tool.ts` writes into the user's project,
 * where React renders text rather than markup. What must never appear is a tag.
 */
function expectNoDangerousConstruct(output: string): void {
  expect(output).not.toMatch(/<script/i);
  expect(output).not.toMatch(REJECTED_ELEMENT_PATTERN);

  for (const tag of liveTags(output)) {
    expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
    expect(collapse(tag)).not.toContain("javascript:");
    expect(collapse(tag)).not.toContain("vbscript:");
    expect(collapse(tag)).not.toContain("data:text/html");
    expect(collapse(tag)).not.toContain("data:application/javascript");
  }
}

interface BypassCase {
  /** Stable identifier used in the test name, so a failure names the payload. */
  readonly id: string;
  /** Where the payload was recorded. */
  readonly source: string;
  readonly input: string;
  /** Patterns that must NOT appear in the output for this payload specifically. */
  readonly forbidden: readonly RegExp[];
}

/**
 * The 14 payloads measured surviving `sanitizeSvg` on 2026-08-11. Rows 1-10 are
 * story.md's Reproduction Steps table verbatim; rows 11-14 are the remaining four
 * of the measured fourteen, each re-measured against the shipped function on
 * 2026-08-12 and confirmed to survive it.
 */
const MEASURED_BYPASSES: readonly BypassCase[] = [
  {
    id: "01-unquoted-event-handler",
    source: "story.md row 1 — `on…=` with no quotes is not matched by the regexes at :9-10",
    input: `<svg onload=alert(1)></svg>`,
    forbidden: [/onload/i],
  },
  {
    id: "02-backtick-event-handler",
    source: "story.md row 2 — backticks are a third quoting form",
    input: "<svg onload=`alert(1)`></svg>",
    forbidden: [/onload/i],
  },
  {
    id: "03-rejoin-manufactures-a-script-tag",
    source: "story.md row 3 — the shipped sanitizer EMITS <script> for this input",
    input: `<svg><scr<script>x</script>ipt>alert(1)</script></svg>`,
    forbidden: [/<script/i, /<\/script/i],
  },
  {
    id: "04-space-before-gt-in-closing-script",
    source: "story.md row 4 — a space before `>` in the closing tag",
    input: `<svg><script >alert(1)</script ></svg>`,
    forbidden: [/<script/i],
  },
  {
    id: "05-character-reference-in-scheme",
    source: "story.md row 5 — `&#106;avascript:`; the parser decodes it before the check",
    input: `<svg><a href="&#106;avascript:alert(1)">x</a></svg>`,
    forbidden: [/avascript:/i, /&#106;/i, /<a\b/i],
  },
  {
    id: "06-whitespace-inside-scheme",
    source: "story.md row 6 — `java\\tscript:`",
    input: `<svg><a href="java\tscript:alert(1)">x</a></svg>`,
    forbidden: [/script:/i, /<a\b/i],
  },
  {
    id: "07-animate-retargets-href",
    source: "story.md row 7 — <animate> can retarget any attribute at runtime",
    input: `<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>`,
    forbidden: [/<animate/i, /attributename/i],
  },
  {
    id: "08-style-element-carries-css-url",
    source: "story.md row 8 — CSS is never inspected by the regexes",
    input: `<svg><style>*{background:url("javascript:alert(1)")}</style></svg>`,
    forbidden: [/<style/i, /background/i],
  },
  {
    id: "09-image-with-data-uri",
    source: "story.md row 9 — the data: pair at :28-31 blocks only two media types",
    input: `<svg><image href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"/></svg>`,
    forbidden: [/<image/i, /base64/i],
  },
  {
    id: "10-unquoted-javascript-href",
    source: "story.md row 10 — the capture group at :16 requires a quote",
    input: `<svg><a href=javascript:alert(1)>x</a></svg>`,
    forbidden: [/javascript:/i, /<a\b/i],
  },
  {
    id: "11-set-retargets-href",
    source: "design.md — <set> retargets an attribute exactly as <animate> does",
    input: `<svg><set attributeName="href" to="javascript:alert(1)"/></svg>`,
    forbidden: [/<set\b/i, /attributename/i],
  },
  {
    id: "12-object-without-a-closing-tag",
    source: "design.md — neither the paired nor the self-closing <object> regex matches",
    input: `<svg><object data="javascript:alert(1)"></svg>`,
    forbidden: [/<object/i, /javascript:/i],
  },
  {
    id: "13-space-before-gt-in-closing-foreignobject",
    source: "design.md — the same closing-tag whitespace hole as row 4, on <foreignObject>",
    input: `<svg><foreignObject><div onclick=alert(1)>x</div></foreignObject ></svg>`,
    forbidden: [/foreignobject/i, /onclick/i, /<div/i],
  },
  {
    id: "14-leading-whitespace-before-scheme",
    source: "design.md — `href=\" javascript:…\"`; :16 requires the scheme to follow the quote",
    input: `<svg><a href=" javascript:alert(1)">x</a></svg>`,
    forbidden: [/javascript:/i, /<a\b/i],
  },
];

/** design.md "Fix Approach 1": the three payloads added while designing the fix. */
const DESIGN_ADDED_PAYLOADS: readonly BypassCase[] = [
  {
    id: "15-newline-inside-event-handler",
    source: "design.md — a newline between the attribute name and `=`",
    input: `<svg onload\n=alert(1)></svg>`,
    forbidden: [/onload/i],
  },
  {
    id: "16-xlink-href-with-character-reference",
    source: "design.md — the xlink form of payload 05",
    input: `<svg><use xlink:href="&#106;avascript:alert(1)"/></svg>`,
    forbidden: [/avascript:/i, /xlink:href/i],
  },
  {
    id: "17-space-before-gt-in-closing-iframe",
    source: "design.md — the closing-tag whitespace hole on <iframe>",
    input: `<svg><iframe src="https://evil.example/x"></iframe ></svg>`,
    forbidden: [/<iframe/i, /evil\.example/i],
  },
];

describe("sanitizeSvg — the 14 measured bypasses (R4.1)", () => {
  it("carries exactly the fourteen payloads measured against the shipped sanitizer", () => {
    expect(MEASURED_BYPASSES).toHaveLength(14);
    expect(new Set(MEASURED_BYPASSES.map((c) => c.id)).size).toBe(14);
  });

  for (const testCase of MEASURED_BYPASSES) {
    it(`removes the construct in bypass ${testCase.id}`, async () => {
      const result = await sanitizeSvg(testCase.input);

      for (const pattern of testCase.forbidden) {
        expect(result).not.toMatch(pattern);
      }
      expectNoDangerousConstruct(result);
    });
  }
});

describe("sanitizeSvg — payloads added during design", () => {
  for (const testCase of DESIGN_ADDED_PAYLOADS) {
    it(`removes the construct in payload ${testCase.id}`, async () => {
      const result = await sanitizeSvg(testCase.input);

      for (const pattern of testCase.forbidden) {
        expect(result).not.toMatch(pattern);
      }
      expectNoDangerousConstruct(result);
    });
  }
});

describe("sanitizeSvg — attribute position (design.md GOTCHA 3)", () => {
  /**
   * The single most important assertion in this story. A prototype that removed
   * attributes while iterating `el.attributes`, with a camelCase allowlist,
   * passed 17 of 17 payload tests and still turned this input into
   * `<svg onload="alert(1)" />`: it removed the safe attribute and kept the
   * dangerous one. An implementation carrying that defect MUST fail here.
   */
  it("removes onload when a removable attribute precedes it", async () => {
    const result = await sanitizeSvg(`<svg viewBox="0 0 9 9" onload="alert(1)"/>`);

    expect(result).not.toMatch(/onload/i);
    expect(result).not.toContain("alert(1)");
  });

  it("keeps viewBox in the same input, rather than removing the safe attribute", async () => {
    const result = await sanitizeSvg(`<svg viewBox="0 0 9 9" onload="alert(1)"/>`);

    expect(result).toMatch(/viewBox\s*=\s*["']0 0 9 9["']/i);
  });

  it("removes every handler in a run of attributes, not only the first", async () => {
    const result = await sanitizeSvg(
      `<svg a1="x" onload="alert(1)" a3="x" onerror="alert(2)" a5="x"></svg>`
    );

    expect(result).not.toMatch(/onload/i);
    expect(result).not.toMatch(/onerror/i);
    expect(result).not.toContain("alert(1)");
    expect(result).not.toContain("alert(2)");
  });

  it("removes a handler that follows several removable attributes", async () => {
    const result = await sanitizeSvg(
      `<svg data-a="1" sodipodi:nodetypes="cc" foo="bar" onload="alert(1)" fill="red"></svg>`
    );

    expect(result).not.toMatch(/onload/i);
    expect(result).not.toMatch(/data-a/i);
    expect(result).not.toMatch(/sodipodi/i);
    expect(result).toMatch(/fill\s*=\s*["']red["']/i);
  });

  it("removes a handler in every position of a five-attribute element", async () => {
    const benign = [`viewBox="0 0 9 9"`, `fill="red"`, `d="M0 0"`, `width="9"`];

    for (let position = 0; position <= benign.length; position++) {
      const attrs = [...benign];
      attrs.splice(position, 0, `onload="alert(1)"`);
      const input = `<path ${attrs.join(" ")}/>`;

      const result = await sanitizeSvg(input);

      expect(result).not.toMatch(/onload/i);
      expect(result).toMatch(/d\s*=\s*["']M0 0["']/i);
    }
  });
});

describe("sanitizeSvg — a removal must not compose into a new construct (R1.4)", () => {
  // Measured 2026-08-12 against a parser-based reference implementation: parsing
  // alone does NOT close this. Stray text carrying "<" on one side of a removed
  // element joins the text on the other side, and the JOIN is markup the parser
  // never saw. The reference emitted <object data="https://evil.example/x"> and
  // <img src=x onerror=alert(1)> from inputs that contained neither as an
  // element. Escaping "<" and ">" in text nodes closes it in a single pass.
  const COMPOSITIONS: ReadonlyArray<{ id: string; input: string; forbidden: RegExp }> = [
    {
      id: "join-forms-an-object-element-with-its-attributes",
      input: '<svg><<script>x</script>object data="https://evil.example/x">y</object></svg>',
      forbidden: /<object\b/i,
    },
    {
      id: "join-forms-an-img-with-an-event-handler",
      input: "<svg><<script>x</script>img src=x onerror=alert(1)>",
      forbidden: /<img\b/i,
    },
    {
      id: "join-forms-a-bare-element-name",
      input: "<<script></script>Object>",
      forbidden: /<object\b/i,
    },
  ];

  for (const composition of COMPOSITIONS) {
    it(`emits no construct formed by the removal: ${composition.id}`, async () => {
      const result = await sanitizeSvg(composition.input);

      expect(result).not.toMatch(composition.forbidden);
      expectNoDangerousConstruct(result);
      for (const tag of liveTags(result)) {
        expect(tag).not.toContain("evil.example");
      }
    });
  }

  it("is a fixed point: a second pass over the output changes nothing", async () => {
    for (const composition of COMPOSITIONS) {
      const once = await sanitizeSvg(composition.input);
      const twice = await sanitizeSvg(once);

      expect(twice).toBe(once);
    }
  });
});

describe("sanitizeSvg — absorbed from src/__tests__/http/svg-sanitizer.test.ts", () => {
  it("strips <script> tags", async () => {
    const input = '<svg><script>alert("xss")</script><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("<script");
    expect(result).toMatch(/<rect\s*\/?>/);
  });

  it("strips self-closing <script/> tags", async () => {
    const input = '<svg><script src="evil.js"/><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("<script");
  });

  it("strips event handlers (onclick)", async () => {
    const input = '<svg><rect onclick="alert(1)" /></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toMatch(/onclick/i);
  });

  it("strips event handlers (onload)", async () => {
    const input = '<svg onload="alert(1)"><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toMatch(/onload/i);
  });

  it("strips <foreignObject>", async () => {
    const input = '<svg><foreignObject><div>html</div></foreignObject><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("foreignObject");
    expect(result).toMatch(/<rect\s*\/?>/);
  });

  it("strips javascript: in href", async () => {
    const input = '<svg><a href="javascript:alert(1)">click</a></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("javascript:");
  });

  it("strips <iframe> tags", async () => {
    const input = '<svg><iframe src="evil.html"></iframe><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("<iframe");
  });

  it("strips <embed> tags", async () => {
    const input = '<svg><embed src="evil.swf"></embed><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("<embed");
  });

  it("strips <object> tags", async () => {
    const input = '<svg><object data="evil.swf"></object><rect/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("<object");
  });

  it("strips dangerous data: URIs in href", async () => {
    const input = '<svg><a href="data:text/html,<script>alert(1)</script>">x</a></svg>';
    const result = await sanitizeSvg(input);
    expect(result).not.toContain("data:text/html");
  });

  it("preserves valid SVG content", async () => {
    const input =
      '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="blue"/><circle cx="50" cy="50" r="20" fill="red"/></svg>';
    const result = await sanitizeSvg(input);
    expect(result).toContain('<rect x="10"');
    expect(result).toContain('<circle cx="50"');
    expect(result).toContain('fill="blue"');
  });
});

describe("sanitizeSvg — a benign logo survives (R1.5)", () => {
  /** Shaped after the Vercel logo measured on 2026-08-11: one <path>, one d=, one self-closing tag. */
  const VERCEL_SHAPED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 76 65" fill="none"><path d="M37.5274 0L75.0548 65H0L37.5274 0Z" fill="#000"/></svg>';

  /** Shaped after the measured logos that carry gradients and clip paths. */
  const GRADIENT_SHAPED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" preserveAspectRatio="xMidYMid meet">' +
    '<g clip-path="url(#clip0)"><path d="M0 0h24v24H0z" fill="url(#grad1)" fill-rule="evenodd"/><path d="M4 4h8v8H4z" opacity="0.5"/></g>' +
    '<defs><linearGradient id="grad1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">' +
    '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
    '<clipPath id="clip0"><rect width="24" height="24"/></clipPath></defs></svg>';

  it("preserves viewBox, the path data and the self-closing tag of a real logo", async () => {
    const result = await sanitizeSvg(VERCEL_SHAPED);

    expect(result).toContain('viewBox="0 0 76 65"');
    expect(result).toContain('d="M37.5274 0L75.0548 65H0L37.5274 0Z"');
    expect(result).toContain('fill="#000"');
    expect(result).toContain("</svg>");
  });

  it("preserves every d= and every self-closing tag, counted", async () => {
    const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

    const result = await sanitizeSvg(GRADIENT_SHAPED);

    expect(count(result, /\sd="/g)).toBe(count(GRADIENT_SHAPED, /\sd="/g));
    expect(count(result, /\/>/g)).toBe(count(GRADIENT_SHAPED, /\/>/g));
    expect(count(result, /<path\b/g)).toBe(count(GRADIENT_SHAPED, /<path\b/g));
    expect(count(result, /<stop\b/g)).toBe(count(GRADIENT_SHAPED, /<stop\b/g));
  });

  it("preserves the camelCase attributes the parser reports in lowercase (GOTCHA 2)", async () => {
    const result = await sanitizeSvg(GRADIENT_SHAPED);

    expect(result).toContain('viewBox="0 0 24 24"');
    expect(result).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(result).toContain('gradientUnits="userSpaceOnUse"');
    expect(result).toContain("<linearGradient");
    expect(result).toContain("<clipPath");
  });

  it("preserves a same-document url(#id) reference in clip-path and fill", async () => {
    const result = await sanitizeSvg(GRADIENT_SHAPED);

    expect(result).toContain('clip-path="url(#clip0)"');
    expect(result).toContain('fill="url(#grad1)"');
  });

  it("removes a url() that leaves the document", async () => {
    const result = await sanitizeSvg(
      '<svg><path d="M0 0" fill="url(https://evil.example/x#a)"/><path d="M1 1" clip-path="url(javascript:alert(1))"/></svg>'
    );

    expect(result).not.toContain("evil.example");
    expect(collapse(result)).not.toContain("javascript:");
    expect(result).toContain('d="M0 0"');
    expect(result).toContain('d="M1 1"');
  });
});

describe("sanitizeSvg — the function is total (R1, fail closed)", () => {
  const HOSTILE_INPUTS: readonly string[] = [
    "",
    "not markup at all",
    "<",
    "<svg",
    "<svg><",
    "</svg>",
    "<svg>\u0000<script>alert(1)</script></svg>",
    "<svg>".repeat(200),
  ];

  for (const input of HOSTILE_INPUTS) {
    it(`returns a string without raising for ${JSON.stringify(input.slice(0, 40))}`, async () => {
      const result = await sanitizeSvg(input);

      expect(typeof result).toBe("string");
      expect(result).not.toMatch(/<script/i);
    });
  }

  it("removes comments, which carry markup the allowlist never inspects", async () => {
    const result = await sanitizeSvg("<svg><!-- <script>alert(1)</script> --><path d=\"M0 0\"/></svg>");

    expect(result).not.toMatch(/<script/i);
    expect(result).not.toContain("<!--");
    expect(result).toContain('d="M0 0"');
  });

  it("leaves a CDATA section inert instead of letting it escape into live markup", async () => {
    // Inside <svg> the parser is in foreign content, where a CDATA section is
    // character data: the markup written in it is text, not elements. The
    // property asserted is that nothing escapes the section — deliberately not
    // that the section is deleted, which would over-constrain the parser.
    const result = await sanitizeSvg("<svg><![CDATA[<script>alert(1)</script>]]></svg>");

    expect(typeof result).toBe("string");
    expect(result.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")).not.toMatch(/<script/i);
  });

  it("is idempotent: sanitizing the output again changes nothing (R1.4)", async () => {
    for (const input of [...MEASURED_BYPASSES, ...DESIGN_ADDED_PAYLOADS].map((c) => c.input)) {
      const once = await sanitizeSvg(input);
      const twice = await sanitizeSvg(once);

      expect(twice).toBe(once);
    }
  });
});
