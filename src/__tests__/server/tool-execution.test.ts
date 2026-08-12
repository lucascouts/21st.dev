/**
 * Every tool is EXECUTED through a real MCP client (R5.1, R5.2 — task 4.1).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tool-contract.test.ts` asserts `tools/list` metadata and says in its own
 * comment that no tool is executed. Measured 2026-08-12: the suite was 398 green
 * while `magic_component_refiner` had never worked in any released 2.x version —
 * every invocation failed before any I/O, because `validate(path, "/")` refuses
 * every real path. A green suite over a tool that cannot run is the gap this
 * file closes: from here on, a tool that cannot function fails the suite.
 *
 * WHY IT DRIVES THE SERVER'S OWN WIRING
 * -------------------------------------
 * The defect above is invisible to a test that calls `execute()` on a hand-built
 * instance with hand-picked settings — that test would simply pass a base the
 * tool never uses in production. So:
 *   - the tools are constructed and registered exactly as `src/server.ts` does,
 *     same classes, same dependencies, same order, each through its own real
 *     `tool.register(server)`, and every invocation goes over the MCP protocol
 *     through a real `Client`;
 *   - the configuration comes from `parseConfig()`, the real parser used by
 *     `src/index.ts`, so a field added to `Config` later arrives here with its
 *     real default rather than a value invented by this file;
 *   - the file paths handed to the two file-reading tools are real files inside
 *     the process's working directory, which is what the shipped default
 *     confines to.
 * `MagicServer.start()` constructs its `StdioServerTransport` internally, so the
 * transport cannot be swapped without changing production code; the registration
 * block below therefore mirrors `src/server.ts` and must be kept in step with
 * it, exactly as `tool-contract.test.ts` already does.
 *
 * WHAT COUNTS AS AN OBSERVABLE RESULT
 * -----------------------------------
 * Never "no exception was raised". Each tool is asserted on a value only a
 * working execution can produce — a sentinel planted in the stubbed response and
 * read back out of the tool's text, a parsed JSON field, a link this project
 * constructed — and on `isError` being unset.
 *
 * STUBS
 * -----
 * `fetch` is replaced by a stub that FOLLOWS REDIRECTS unless the caller passed
 * `redirect: "manual"`, because that is what the platform does and a stub that
 * does not model it lets an unfixed implementation look safe (story 005 shipped
 * exactly that mistake). Any URL the stub was not taught is recorded and
 * asserted against, so an unexpected outbound request fails the run instead of
 * escaping it. `BrowserDetector.openUrl` is stubbed to report failure: no
 * browser is launched, and both browser-driven tools take their manual path.
 * No test here reaches a network host.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig, type Config } from "../../config.js";
import { HttpClient } from "../../http/client.js";
import { BrowserDetector } from "../../browser/detector.js";
import type { Logger } from "../../logger.js";

import { CreateUiTool } from "../../tools/create-ui.tool.js";
import { FetchUiTool } from "../../tools/fetch-ui.tool.js";
import { RefineUiTool } from "../../tools/refine-ui.tool.js";
import { LogoSearchTool } from "../../tools/logo-search.tool.js";
import { HealthCheckTool } from "../../tools/health-check.tool.js";
import { CanvasUiTool } from "../../tools/canvas-ui.tool.js";

const API_BASE = "https://magic.21st.dev";

/** Sentinels: each is producible only by a tool that really ran its path. */
const FETCH_UI_SENTINEL = "FETCH-UI-RESPONSE-SENTINEL-2e90";
const REFINE_UI_SENTINEL = "REFINE-UI-RESPONSE-SENTINEL-6c14";
const LOGO_TITLE = "GithubTest";

const BENIGN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">' +
  '<path d="M12 0C5.37 0 0 5.37 0 12z" fill="#181717"/></svg>';

/** A real, existing file inside the working directory — the shipped default root. */
const IN_ROOT_FILE = path.join(process.cwd(), "package.json");

/** The statuses a `Location` is followed from, and how far the stub follows. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const STUB_FOLLOW_LIMIT = 20;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "error" as const,
} as unknown as Logger;

function testConfig(): Config {
  const previous = process.env.TWENTY_FIRST_API_KEY;
  process.env.TWENTY_FIRST_API_KEY = "test-key-never-sent";
  try {
    return parseConfig();
  } finally {
    if (previous === undefined) delete process.env.TWENTY_FIRST_API_KEY;
    else process.env.TWENTY_FIRST_API_KEY = previous;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** URLs the stub was never taught. Asserted empty: nothing may leave unnoticed. */
const unexpectedRequests: string[] = [];
const requestedUrls: string[] = [];

function respondTo(url: string): Response {
  if (url === `${API_BASE}/api/fetch-ui`) return jsonResponse({ text: FETCH_UI_SENTINEL });
  if (url === `${API_BASE}/api/refine-ui`) return jsonResponse({ text: REFINE_UI_SENTINEL });
  if (url === `${API_BASE}/health`) return jsonResponse({ status: "ok" });

  if (url.startsWith("https://api.svgl.app")) {
    return jsonResponse([{ title: LOGO_TITLE, route: "https://svgl.app/library/github-test.svg" }]);
  }
  if (url === "https://svgl.app/library/github-test.svg") {
    return new Response(BENIGN_SVG, { status: 200, headers: { "Content-Type": "image/svg+xml" } });
  }

  unexpectedRequests.push(url);
  return new Response("stub: unexpected request", { status: 599 });
}

let originalFetch: typeof globalThis.fetch;

function installFetchStub(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let target = typeof input === "string" ? input : input.toString();

    for (let hop = 0; hop < STUB_FOLLOW_LIMIT; hop++) {
      requestedUrls.push(target);
      const response = respondTo(target);

      if (init?.redirect === "manual") return Promise.resolve(response);

      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get("location")
        : null;
      if (location === null || location.length === 0) return Promise.resolve(response);

      target = new URL(location, target).toString();
    }

    return Promise.reject(new Error("stub: too many redirects"));
  }) as unknown as typeof fetch;
}

/** The real detector with only `openUrl` replaced — no browser process starts. */
class NonOpeningBrowserDetector extends BrowserDetector {
  readonly openedUrls: string[] = [];

  async openUrl(url: string): Promise<boolean> {
    this.openedUrls.push(url);
    return false;
  }
}

let server: McpServer;
let client: Client;
let browserDetector: NonOpeningBrowserDetector;
let advertisedNames: string[] = [];

/** Mirrors src/server.ts — same classes, same construction, same order. */
function buildTools(config: Config, httpClient: HttpClient) {
  return [
    new CreateUiTool({ httpClient, browserDetector, logger: silentLogger, config }),
    new FetchUiTool({ httpClient, logger: silentLogger }),
    new RefineUiTool({ httpClient, logger: silentLogger, config }),
    new LogoSearchTool({ logger: silentLogger }),
    new HealthCheckTool({ httpClient, logger: silentLogger }),
    new CanvasUiTool({ browserDetector, logger: silentLogger, config }),
  ];
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** Every tool invoked here. Asserted below to be the whole advertised surface. */
const INVOKED_TOOLS = [
  "magic_component_builder",
  "magic_component_inspiration",
  "magic_component_refiner",
  "magic_logo_search",
  "magic_health_check",
  "magic_component_canvas",
] as const;

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { text: textOf(result), errored: isError(result) };
}

describe("every tool executes through a real MCP client", () => {
  beforeAll(async () => {
    installFetchStub();

    const config = testConfig();
    browserDetector = new NonOpeningBrowserDetector(silentLogger);

    // Mirrors src/index.ts: the real client, one non-debug base URL.
    const httpClient = new HttpClient({
      baseUrl: API_BASE,
      apiKey: config.apiKey,
      timeout: 5_000,
      retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1, jitterMax: 0 },
      logger: silentLogger,
    });

    server = new McpServer({ name: "magic-mcp", version: "2.0.0" });
    for (const tool of buildTools(config, httpClient)) {
      tool.register(server);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "tool-execution-test", version: "2.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    advertisedNames = tools.map((tool) => tool.name);
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    globalThis.fetch = originalFetch;
  });

  it("executes every advertised tool — none is left unexercised", () => {
    // Guards the gap itself: a seventh tool added without an invocation here
    // fails this assertion instead of shipping unexecuted.
    expect([...advertisedNames].sort()).toEqual([...INVOKED_TOOLS].sort());
  });

  it("magic_component_refiner refines a real file and returns the refined text", async () => {
    // THE DEFECT THIS FILE EXISTS FOR. Against the current tree this tool
    // errors before any I/O, so no request is made and no text comes back.
    const result = await call("magic_component_refiner", {
      userMessage: "tighten the spacing",
      absolutePathToRefiningFile: IN_ROOT_FILE,
      context: "spacing",
    });

    expect(result.errored).toBe(false);
    expect(result.text).toContain(REFINE_UI_SENTINEL);
    // The request really left: the tool read the file and called the API.
    expect(requestedUrls).toContain(`${API_BASE}/api/refine-ui`);
  });

  it("magic_component_inspiration returns the API's component text", async () => {
    const result = await call("magic_component_inspiration", {
      message: "I need a pricing table",
      searchQuery: "pricing table",
    });

    expect(result.errored).toBe(false);
    expect(result.text).toContain(FETCH_UI_SENTINEL);
  });

  it("magic_component_builder falls back to the API and offers a manual link", async () => {
    const result = await call("magic_component_builder", {
      message: "add a pricing card",
      searchQuery: "pricing card",
      absolutePathToCurrentFile: IN_ROOT_FILE,
      standaloneRequestQuery: "a pricing card component",
    });

    expect(result.errored).toBe(false);
    expect(result.text).toContain(FETCH_UI_SENTINEL);
    // The browser could not be opened, so the URL this project built is offered
    // for manual use — and it is the one that was really passed to `openUrl`.
    expect(result.text).toContain("https://21st.dev/magic-chat");
    expect(browserDetector.openedUrls.some((url) => result.text.includes(url))).toBe(true);
  });

  it("magic_component_canvas offers the canvas link when the browser cannot open", async () => {
    const result = await call("magic_component_canvas", {
      message: "design a settings panel",
      standaloneRequestQuery: "a settings panel with tabs",
    });

    expect(result.errored).toBe(false);
    expect(result.text).toContain("https://21st.dev/canvas/new");
  });

  it("magic_logo_search returns a component built from the fetched logo", async () => {
    const result = await call("magic_logo_search", { queries: ["github"], format: "TSX" });

    expect(result.errored).toBe(false);

    const payload = JSON.parse(result.text) as {
      icons: Array<{ icon: string; code: string }>;
      notFound: Array<{ icon: string; error: string }>;
    };
    expect(payload.notFound).toEqual([]);
    expect(payload.icons.length).toBe(1);
    expect(payload.icons[0]?.icon).toBe("github");
    expect(payload.icons[0]?.code).toContain("<svg");
  });

  it("magic_health_check reports the API it just reached", async () => {
    const result = await call("magic_health_check", {});

    expect(result.errored).toBe(false);

    const payload = JSON.parse(result.text) as {
      status: string;
      checks: { api_reachable: boolean };
    };
    expect(payload.checks.api_reachable).toBe(true);
    expect(payload.status).toBe("healthy");
  });

  it("issued no request the stub was not taught", () => {
    // Runs last: every URL above is one this file chose to answer, so nothing
    // reached a host by accident.
    expect(unexpectedRequests).toEqual([]);
  });
});
