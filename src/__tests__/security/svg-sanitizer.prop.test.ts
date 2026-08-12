import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { sanitizeSvg } from "../../security/svg-sanitizer.js";

/**
 * Property tests for the parser-based sanitizer (story 005, R4.2 and R4.3).
 *
 * The generator produces the PAYLOAD — element name, attribute name, quoting
 * form, character-reference encoding and, above all, the POSITION of the
 * dangerous attribute among benign ones. It follows the construction in
 * src/__tests__/security/log-sanitizer.prop.test.ts, which generates the secret,
 * and deliberately not the one this story deleted alongside the regex
 * sanitizer, which held the payload fixed and fuzzed the text around it — the
 * defect R4 exists to close.
 *
 * Generated attribute order is the reason this file exists in this shape: the
 * design prototype passed 17 of 17 fixed payloads and still emitted
 * `<svg viewBox="0 0 9 9" onload="alert(1)"/>` as `<svg onload="alert(1)" />`,
 * because it removed an attribute while iterating `el.attributes`. Only a
 * generated order reaches that.
 *
 * Every input is synthesised in-process: no test here touches the network.
 */

/**
 * The payload marker. Only its FIRST character is ever character-reference
 * encoded, so `MARKER_TAIL` identifies the payload in the output whether the
 * generator encoded it or not.
 */
const MARKER_TAIL = "WNED_MARKER_1";
const MARKER = `P${MARKER_TAIL}`;

/** Every LIVE tag in the output. Text the sanitizer escaped yields none. */
function liveTags(markup: string): readonly string[] {
  return markup.match(/<[a-zA-Z/!][^>]*>/g) ?? [];
}

/**
 * Asserts no live tag in the output carries an event handler. Scoped to live
 * markup deliberately: escaped text is inert both as SVG and as the JSX/TSX
 * `logo-search.tool.ts` writes into the user's project.
 */
function expectNoEventHandler(output: string): void {
  for (const tag of liveTags(output)) {
    expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
  }
}

/** Whitespace-insensitive, case-insensitive view of the output. */
function collapse(markup: string): string {
  return markup.replace(/\s+/g, "").toLowerCase();
}

type Quoting = "double" | "single" | "unquoted" | "backtick";

const quotingArb: fc.Arbitrary<Quoting> = fc.constantFrom<Quoting>(
  "double",
  "single",
  "unquoted",
  "backtick"
);

/** A generated per-character case mask, so `onload` also arrives as `oNLoAd`. */
const caseMaskArb = fc.array(fc.boolean(), { minLength: 24, maxLength: 24 });

function applyCase(name: string, mask: readonly boolean[]): string {
  return name
    .split("")
    .map((char, index) => (mask[index % mask.length] ? char.toUpperCase() : char.toLowerCase()))
    .join("");
}

function renderAttribute(name: string, value: string, quoting: Quoting): string {
  switch (quoting) {
    case "double":
      return `${name}="${value}"`;
    case "single":
      return `${name}='${value}'`;
    case "backtick":
      return `${name}=\`${value}\``;
    case "unquoted":
      // An unquoted value ends at the first whitespace, so a value containing
      // whitespace or a quote is only generated for the quoted forms.
      return `${name}=${value.replace(/[\s"']/g, "")}`;
  }
}

/** Character-reference and whitespace obfuscations of a scheme or a payload. */
type Obfuscation = "none" | "decimal" | "hex" | "padded-decimal" | "raw-tab" | "raw-newline" | "named-tab";

const obfuscationArb: fc.Arbitrary<Obfuscation> = fc.constantFrom<Obfuscation>(
  "none",
  "decimal",
  "hex",
  "padded-decimal",
  "raw-tab",
  "raw-newline",
  "named-tab"
);

/** Encodes the first character of `text`, or splices whitespace after it. */
function obfuscate(text: string, how: Obfuscation, allowRawWhitespace: boolean): string {
  const head = text.charCodeAt(0);
  const tail = text.slice(1);
  switch (how) {
    case "none":
      return text;
    case "decimal":
      return `&#${head};${tail}`;
    case "hex":
      return `&#x${head.toString(16)};${tail}`;
    case "padded-decimal":
      return `&#${String(head).padStart(7, "0")};${tail}`;
    case "raw-tab":
      return allowRawWhitespace ? `${text[0]}\t${tail}` : `&#9;${text}`;
    case "raw-newline":
      return allowRawWhitespace ? `${text[0]}\n${tail}` : `&#10;${text}`;
    case "named-tab":
      return `${text[0]}&Tab;${tail}`;
  }
}

const EVENT_ATTRIBUTE_NAMES = [
  "onload",
  "onerror",
  "onclick",
  "onmouseover",
  "onfocus",
  "onbegin",
  "onend",
  "onrepeat",
  "onactivate",
  "onanimationstart",
] as const;

/**
 * Benign attributes: a deliberate mix of allowlisted ones (which must survive)
 * and rejected ones (whose REMOVAL is what corrupts a naive attribute
 * iterator). Both kinds must be able to sit before the dangerous attribute.
 */
const ALLOWLISTED_ATTRIBUTES = [
  `viewBox="0 0 9 9"`,
  `fill="red"`,
  `width="9"`,
  `height="9"`,
  `opacity="0.5"`,
  `id="logo"`,
] as const;

const REJECTED_ATTRIBUTES = [
  `data-testid="x"`,
  `sodipodi:nodetypes="cc"`,
  `foo="bar"`,
  `inkscape:label="layer"`,
  `formaction="/x"`,
] as const;

const ALLOWED_ELEMENT_NAMES = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
  "defs",
  "linearGradient",
  "radialGradient",
  "clipPath",
  "stop",
  "use",
  "symbol",
  "text",
  "tspan",
  "mask",
  "pattern",
] as const;

const REJECTED_ELEMENT_NAMES = [
  "script",
  "style",
  "foreignObject",
  "animate",
  "animateTransform",
  "set",
  "image",
  "iframe",
  "embed",
  "object",
  "a",
] as const;

/** Elements the HTML parser treats as void, so markup after them is a sibling. */
const VOID_IN_HTML = new Set<string>(["embed"]);

const URI_BEARING_ATTRIBUTES = ["href", "xlink:href", "fill", "stroke", "clip-path", "mask", "style"] as const;

describe("sanitizeSvg property tests — the generator produces the payload (R4.2)", () => {
  it("removes a generated event handler whatever its name, case, quoting or position", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          element: fc.constantFrom(...ALLOWED_ELEMENT_NAMES),
          elementCase: caseMaskArb,
          handler: fc.constantFrom(...EVENT_ATTRIBUTE_NAMES),
          handlerCase: caseMaskArb,
          quoting: quotingArb,
          obfuscation: obfuscationArb,
          before: fc.array(fc.constantFrom(...ALLOWLISTED_ATTRIBUTES, ...REJECTED_ATTRIBUTES), {
            maxLength: 4,
          }),
          after: fc.array(fc.constantFrom(...ALLOWLISTED_ATTRIBUTES, ...REJECTED_ATTRIBUTES), {
            maxLength: 4,
          }),
          selfClosing: fc.boolean(),
          wrapped: fc.boolean(),
        }),
        async (spec) => {
          const quoted = spec.quoting !== "unquoted";
          const value = obfuscate(`alert(${MARKER})`, spec.obfuscation, quoted);
          const handler = renderAttribute(
            applyCase(spec.handler, spec.handlerCase),
            value,
            spec.quoting
          );
          const tag = applyCase(spec.element, spec.elementCase);
          const attributes = [...spec.before, handler, ...spec.after].join(" ");
          const element = spec.selfClosing
            ? `<${tag} ${attributes}/>`
            : `<${tag} ${attributes}></${tag}>`;
          const markup = spec.wrapped ? `<svg viewBox="0 0 9 9">${element}</svg>` : element;

          const output = await sanitizeSvg(markup);

          expectNoEventHandler(output);
          expect(output).not.toContain(MARKER_TAIL);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("removes the handler AND keeps the allowlisted attributes, at every generated order", async () => {
    // The design prototype failed exactly here: it removed the safe attribute
    // (viewBox, dropped by a camelCase allowlist) and kept the dangerous one.
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          handler: fc.constantFrom(...EVENT_ATTRIBUTE_NAMES),
          handlerCase: caseMaskArb,
          quoting: quotingArb,
          removable: fc.array(fc.constantFrom(...REJECTED_ATTRIBUTES), { maxLength: 3 }),
          handlerIndex: fc.nat({ max: 8 }),
        }),
        async (spec) => {
          const keepers = [
            `viewBox="0 0 9 9"`,
            `preserveAspectRatio="xMidYMid meet"`,
            `width="9"`,
            `fill="red"`,
          ];
          const attributes = [...keepers, ...spec.removable];
          const handler = renderAttribute(
            applyCase(spec.handler, spec.handlerCase),
            `alert(${MARKER})`,
            spec.quoting
          );
          attributes.splice(spec.handlerIndex % (attributes.length + 1), 0, handler);
          const markup = `<svg ${attributes.join(" ")}></svg>`;

          const output = await sanitizeSvg(markup);

          expectNoEventHandler(output);
          expect(output).not.toContain(MARKER_TAIL);
          for (const keeper of keepers) {
            expect(output).toContain(keeper);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("removes a generated rejected element, whatever its case, closing form or attributes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          element: fc.constantFrom(...REJECTED_ELEMENT_NAMES),
          elementCase: caseMaskArb,
          closing: fc.constantFrom("paired", "self-closing", "space-before-gt", "unclosed"),
          attributes: fc.array(fc.constantFrom(...REJECTED_ATTRIBUTES), { maxLength: 2 }),
          wrapped: fc.boolean(),
        }),
        async (spec) => {
          const tag = applyCase(spec.element, spec.elementCase);
          const attributes = ` src="https://evil.example/x" ${spec.attributes.join(" ")}`;
          let element: string;
          switch (spec.closing) {
            case "self-closing":
              element = `<${tag}${attributes}/>`;
              break;
            case "space-before-gt":
              element = `<${tag}${attributes} >${MARKER}</${tag} >`;
              break;
            case "unclosed":
              element = `<${tag}${attributes}>${MARKER}`;
              break;
            default:
              element = `<${tag}${attributes}>${MARKER}</${tag}>`;
          }
          const markup = spec.wrapped ? `<svg viewBox="0 0 9 9">${element}</svg>` : element;

          const output = await sanitizeSvg(markup);

          expect(output).not.toMatch(new RegExp(`<${spec.element}\\b`, "i"));
          expect(output).not.toContain("evil.example");
          if (!VOID_IN_HTML.has(spec.element)) {
            // <embed> is void in the HTML parser: the text written after it is a
            // sibling text node, not element content, so removing the element
            // leaves inert text behind. The property asserted for it is that the
            // ELEMENT and its attributes are gone — inert text is not a bypass.
            expect(output).not.toContain(MARKER_TAIL);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("removes a rejected element assembled by the removal of an inner one (R1.4)", async () => {
    // The shipped regex sanitizer MANUFACTURES a tag here: removing the inner
    // <script>x</script> joins `<scr` to `ipt>`. The generator varies the tag
    // and the split point, so the property covers the construction, not the
    // one example story.md recorded.
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          element: fc.constantFrom(...REJECTED_ELEMENT_NAMES),
          splitAt: fc.nat({ max: 12 }),
          inner: fc.constantFrom(...REJECTED_ELEMENT_NAMES),
          wrapped: fc.boolean(),
        }),
        async (spec) => {
          const tag = spec.element;
          const cut = 1 + (spec.splitAt % Math.max(tag.length - 1, 1));
          const head = tag.slice(0, cut);
          const tail = tag.slice(cut);
          const split = `<${head}<${spec.inner}>x</${spec.inner}>${tail}>${MARKER}</${tag}>`;
          const markup = spec.wrapped ? `<svg viewBox="0 0 9 9">${split}</svg>` : split;

          const output = await sanitizeSvg(markup);

          expect(output).not.toMatch(new RegExp(`<${tag}\\b`, "i"));
          expect(output).not.toMatch(new RegExp(`<${spec.inner}\\b`, "i"));
          expect(output).not.toMatch(/<script/i);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("removes a generated dangerous URI whatever its encoding, quoting or attribute", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          element: fc.constantFrom(...ALLOWED_ELEMENT_NAMES),
          attribute: fc.constantFrom(...URI_BEARING_ATTRIBUTES),
          scheme: fc.constantFrom("javascript", "vbscript", "JaVaScRiPt"),
          obfuscation: obfuscationArb,
          quoting: quotingArb,
          wrappedInUrlFunction: fc.boolean(),
          leadingSpace: fc.boolean(),
        }),
        async (spec) => {
          const quoted = spec.quoting !== "unquoted";
          const scheme = obfuscate(spec.scheme, spec.obfuscation, quoted);
          const uri = `${scheme}:alert(${MARKER})`;
          const body = spec.wrappedInUrlFunction ? `url(${uri})` : uri;
          const value = spec.leadingSpace && quoted ? ` ${body}` : body;
          const markup = `<${spec.element} ${renderAttribute(spec.attribute, value, spec.quoting)}></${spec.element}>`;

          const output = await sanitizeSvg(markup);

          expect(collapse(output)).not.toContain("javascript:");
          expect(collapse(output)).not.toContain("vbscript:");
          expect(output).not.toContain(MARKER_TAIL);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("needs no second pass: sanitizing generated markup twice equals sanitizing it once (R1.4)", async () => {
    const fragmentArb = fc.constantFrom(
      "<scr",
      "ipt>",
      "<script>",
      "</script>",
      "<sty",
      "le>",
      "<foreign",
      "Object>",
      "<svg>",
      "</svg>",
      `<path d="M0 0"/>`,
      `<g fill="red">`,
      "</g>",
      "<",
      ">",
      "/",
      " ",
      `onload="alert(1)"`,
      "&#106;",
      "&Tab;",
      "javascript:",
      MARKER
    );

    await fc.assert(
      fc.asyncProperty(fc.array(fragmentArb, { minLength: 1, maxLength: 12 }), async (fragments) => {
        const markup = fragments.join("");

        const once = await sanitizeSvg(markup);
        const twice = await sanitizeSvg(once);

        expect(twice).toBe(once);
        expect(once).not.toMatch(/<script/i);
        expect(once).not.toMatch(/<style\b/i);
        expect(once).not.toMatch(/<foreignobject\b/i);
      }),
      { numRuns: 300 }
    );
  });
});
