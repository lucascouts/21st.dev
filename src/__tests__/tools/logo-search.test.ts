import { describe, it, expect, afterEach } from "bun:test";
import { LogoSearchTool } from "../../tools/logo-search.tool.js";

/**
 * Integration tests for the logo pipeline (story 005, R2.1-R2.2 and R3.1-R3.3).
 *
 * `fetch` is replaced by a counting stub, so no test here reaches api.svgl.app or
 * any other host. The requirement under test is that a malformed response and a
 * refused URL each fail ONE query WITHOUT issuing the follow-up request — which
 * is why every such test asserts the CALL COUNT. An assertion on the error
 * message would pass even if the request had been made.
 */

interface FetchRecord {
  readonly calls: string[];
  restore(): void;
}

const SEARCH_HOST = "https://api.svgl.app";

/** Replaces global fetch with a stub that records every URL it is called with. */
function installFetch(handler: (url: string) => Response): FetchRecord {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return Promise.resolve(handler(url));
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
function searchHit(route: unknown = "https://cdn.svgl.app/library/github.svg"): unknown {
  return [{ id: 1, title: "GitHub", category: "Software", route, url: "https://svgl.app/github" }];
}

describe("LogoSearchTool — a benign response still works (regression)", () => {
  for (const format of ["JSX", "TSX", "SVG"] as const) {
    it(`returns ${format} for a well-formed response`, async () => {
      const logs: CapturedLog[] = [];
      installed = installFetch((url) =>
        url.startsWith(SEARCH_HOST) ? jsonResponse(searchHit()) : svgResponse(BENIGN_SVG)
      );
      const tool = new LogoSearchTool({ logger: createLogger(logs) as never });

      const output = await run(tool, ["github"], format);

      expect(output.notFound).toHaveLength(0);
      expect(output.icons).toHaveLength(1);
      expect(output.icons[0]?.icon).toBe("github");
      expect(output.icons[0]?.code).toContain("<svg");
      expect(output.icons[0]?.code).toContain("<path");
      expect(output.icons[0]?.code).toContain('d="M12 0C5.37 0 0 5.37 0 12z"');
      if (format !== "SVG") {
        expect(output.icons[0]?.code).toContain("GitHubIcon");
      }
      expect(installed.calls).toHaveLength(2);
    });
  }

  it("follows the light route when the response carries a theme object", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse(
            searchHit({
              light: "https://cdn.svgl.app/library/github-light.svg",
              dark: "https://cdn.svgl.app/library/github-dark.svg",
            })
          )
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.icons).toHaveLength(1);
    expect(installed.calls[1]).toBe("https://cdn.svgl.app/library/github-light.svg");
  });

  it("accepts unknown keys, so an upstream field addition is not an outage (R2.1)", async () => {
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse([
            {
              id: 1,
              title: "GitHub",
              category: ["Software", "AI"],
              route: "https://cdn.svgl.app/library/github.svg",
              url: "https://svgl.app/github",
              wordmark: "https://cdn.svgl.app/library/github-wordmark.svg",
              brandUrl: "https://github.com",
              addedInVersionThatDidNotExistYet: { nested: true },
            },
          ])
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.icons).toHaveLength(1);
    expect(output.notFound).toHaveLength(0);
    expect(installed.calls).toHaveLength(2);
  });
});

describe("LogoSearchTool — a response failing the schema issues no follow-up request (R2.2)", () => {
  const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
    ["title is a number", [{ id: 1, title: 42, route: "https://cdn.svgl.app/library/x.svg" }]],
    ["title is missing", [{ id: 1, route: "https://cdn.svgl.app/library/x.svg" }]],
    ["route is a number", [{ id: 1, title: "GitHub", route: 7 }]],
    ["route is missing", [{ id: 1, title: "GitHub" }]],
    ["route is null", [{ id: 1, title: "GitHub", route: null }]],
    ["route object has no light", [{ id: 1, title: "GitHub", route: { dark: "https://cdn.svgl.app/d.svg" } }]],
    ["route object light is a number", [{ id: 1, title: "GitHub", route: { light: 1, dark: 2 } }]],
    ["the body is an object, not an array", { logos: [] }],
    ["the body is a string", "no logos here"],
    ["an entry is a string", ["github"]],
    ["an entry is null", [null]],
  ];

  for (const [description, body] of MALFORMED) {
    it(`reports the query failed and issues exactly one request when ${description}`, async () => {
      installed = installFetch((url) =>
        url.startsWith(SEARCH_HOST) ? jsonResponse(body) : svgResponse(BENIGN_SVG)
      );
      const tool = new LogoSearchTool({ logger: createLogger([]) as never });

      const output = await run(tool, ["github"], "SVG");

      expect(output.icons).toHaveLength(0);
      expect(output.notFound).toHaveLength(1);
      expect(output.notFound[0]?.icon).toBe("github");
      // The search request is made; nothing derived from the body may follow it.
      expect(installed.calls).toHaveLength(1);
      expect(installed.calls[0]?.startsWith(SEARCH_HOST)).toBe(true);
    });
  }
});

describe("LogoSearchTool — a refused URL issues no follow-up request (R3.1, R3.2)", () => {
  const REFUSED_ROUTES: ReadonlyArray<readonly [string, string]> = [
    ["loopback", "https://127.0.0.1/logo.svg"],
    ["loopback name", "https://localhost:8080/logo.svg"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/logo.svg"],
    ["link-local metadata address", "https://169.254.169.254/latest/meta-data/iam/"],
    ["private 10/8", "https://10.0.0.1/logo.svg"],
    ["private 192.168/16", "https://192.168.1.1/logo.svg"],
    ["private 172.16/12", "https://172.16.0.1/logo.svg"],
    ["non-https scheme", "http://cdn.svgl.app/library/github.svg"],
    ["file scheme", "file:///etc/passwd"],
    ["data scheme", "data:image/svg+xml,<svg onload=alert(1)/>"],
    ["unparseable", "not-a-url"],
  ];

  for (const [description, route] of REFUSED_ROUTES) {
    it(`reports the query failed and issues exactly one request for a ${description} route`, async () => {
      installed = installFetch((url) =>
        url.startsWith(SEARCH_HOST) ? jsonResponse(searchHit(route)) : svgResponse(BENIGN_SVG)
      );
      const tool = new LogoSearchTool({ logger: createLogger([]) as never });

      const output = await run(tool, ["github"], "SVG");

      expect(output.icons).toHaveLength(0);
      expect(output.notFound).toHaveLength(1);
      expect(installed.calls).toHaveLength(1);
    });
  }

  it("logs the refusal at warn with the host and without the credentials (R3.3)", async () => {
    const logs: CapturedLog[] = [];
    installed = installFetch((url) =>
      url.startsWith(SEARCH_HOST)
        ? jsonResponse(searchHit("https://admin:s3cr3t-token@127.0.0.1/logo.svg"))
        : svgResponse(BENIGN_SVG)
    );
    const tool = new LogoSearchTool({ logger: createLogger(logs) as never });

    const output = await run(tool, ["github"], "SVG");

    expect(output.notFound).toHaveLength(1);
    expect(installed.calls).toHaveLength(1);

    const warnings = logs.filter((entry) => entry.level === "warn");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((entry) => entry.text.includes("127.0.0.1"))).toBe(true);
    for (const entry of logs) {
      expect(entry.text).not.toContain("s3cr3t-token");
      expect(entry.text).not.toContain("admin:");
    }
  });
});

describe("LogoSearchTool — one failed query does not fail the batch (regression)", () => {
  it("returns the good logo and reports only the bad one", async () => {
    installed = installFetch((url) => {
      if (url.startsWith(`${SEARCH_HOST}?search=github`)) return jsonResponse(searchHit());
      if (url.startsWith(`${SEARCH_HOST}?search=broken`)) return jsonResponse([{ id: 2, title: 99 }]);
      if (url.startsWith(`${SEARCH_HOST}?search=internal`)) {
        return jsonResponse(searchHit("https://169.254.169.254/latest/meta-data/"));
      }
      return svgResponse(BENIGN_SVG);
    });
    const tool = new LogoSearchTool({ logger: createLogger([]) as never });

    const output = await run(tool, ["github", "broken", "internal"], "SVG");

    expect(output.icons.map((icon) => icon.icon)).toEqual(["github"]);
    expect(output.notFound.map((entry) => entry.icon).sort()).toEqual(["broken", "internal"]);
    // Three searches, and exactly one SVG fetch — the two failed queries issued none.
    expect(installed.calls).toHaveLength(4);
    expect(installed.calls.filter((url) => !url.startsWith(SEARCH_HOST))).toHaveLength(1);
  });
});
