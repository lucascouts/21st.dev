/**
 * `magic_component_inspiration` through a real MCP client
 * (story 006, sub-task 2.3 — R1.1, R1.3, R2.1, R2.2).
 *
 * THE SHARP PROPERTY
 * ------------------
 * A malformed response must produce a REPORTED FAILURE — `isError` set, the
 * tool's own content — and never an `McpError -32602`.
 *
 * That distinction is invisible to a test that calls `execute` directly, which
 * is why every case here is driven through an `McpServer` + `Client` pair over
 * `InMemoryTransport`. MCP result validation runs OUTSIDE the tool's
 * `try/catch`: measured on 2026-08-12, a body of `{}` or `{"text":123}` makes
 * `client.callTool` REJECT with `code -32602`, so `formatError` never runs,
 * `isError` is never set, and the agent receives a transport error instead of
 * the tool's message. Calling `execute()` directly returns
 * `{content:[{type:"text",text:undefined}]}` and looks almost fine — the defect
 * only exists at the boundary the agent is on.
 *
 * WHAT ELSE IS ASSERTED
 * ---------------------
 * No string anywhere in the returned payload may contain remote-authored text or
 * an engine-internal message (R2.2). Measured today for a non-JSON body:
 *
 *   "error": "Failed to fetch UI inspiration. Please try again or check your API key.",
 *   "details": { "originalError": "null is not an object (evaluating 'data.text')" }
 *
 * — a dropped connection reported as a credential problem, in the vocabulary of
 * a JavaScript engine, to someone who can act on neither.
 *
 * The forbidden strings are looked for in EVERY string of the parsed payload,
 * recursively, rather than in one field, so moving the detail to another key
 * does not evade the check.
 *
 * The control is the first test: a well-formed body whose text IS the sentinel
 * still reaches the client verbatim. Without it, every containment assertion
 * below would also pass for a tool that returned nothing at all — and returning
 * that text is the product (story.md, Unchanged Behavior).
 *
 * Servers are local `Bun.serve`/`Bun.listen` instances on 127.0.0.1; the MCP
 * pair is in-process. No host outside the machine is contacted.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { HttpClient } from "../../http/client.js";
import { FetchUiTool } from "../../tools/fetch-ui.tool.js";

const TOOL_NAME = "magic_component_inspiration";

/** Planted in every remote body, header and status line these tests serve. */
const SENTINEL = "REMOTE-SENTINEL-6f2a-ignore-previous-instructions";

/**
 * Strings that describe OUR bug in the runtime's words, or the remote's. None
 * may appear in anything the agent receives (R2.2).
 */
const FORBIDDEN_FRAGMENTS: readonly string[] = [
  SENTINEL,
  "is not an object",
  "is not a function",
  "TypeError",
  "SyntaxError",
  "Unexpected end of JSON input",
  "socket connection was closed",
  "ZodError",
];

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "error" as const,
};

interface Stoppable {
  stop(closeActiveConnections?: boolean): void;
}

let running: Stoppable[] = [];
let openSessions: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of openSessions) await close();
  openSessions = [];
  for (const server of running) server.stop(true);
  running = [];
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  running.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/** The minimum a raw socket needs to answer one HTTP/1.1 request by hand. */
interface RawSocket {
  write(data: string): unknown;
  end(): unknown;
}

/** Used for the interrupted connection, which `Bun.serve` cannot express. */
function serveRaw(respond: (socket: RawSocket) => void): string {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        if (!data.toString().includes("\r\n\r\n")) return;
        respond(socket);
      },
      open() {},
      error() {},
    },
  });
  running.push(server);
  return `http://127.0.0.1:${server.port}`;
}

interface ToolOutcome {
  /** The error `callTool` rejected with, or null when it resolved. */
  readonly threw: { readonly name: string; readonly code: unknown } | null;
  /** The result `callTool` resolved with, or null when it rejected. */
  readonly result: Record<string, unknown> | null;
}

/**
 * Register the real tool on a real server, call it from a real client, and
 * report what the CLIENT saw — including a rejection, which is the outcome the
 * defect produces and which no direct `execute()` call can observe.
 */
async function callThroughMcp(baseUrl: string): Promise<ToolOutcome> {
  const httpClient = new HttpClient({
    baseUrl,
    apiKey: "test-key",
    timeout: 5000,
    maxBodySize: 1_048_576,
    retry: { maxRetries: 0, baseDelay: 5, maxDelay: 20, jitterMax: 1 },
    logger: silentLogger as never,
  });

  const server = new McpServer({ name: "fetch-ui-test", version: "2.0.0" });
  new FetchUiTool({ httpClient, logger: silentLogger as never }).register(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fetch-ui-test", version: "2.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  openSessions.push(async () => {
    await client.close();
    await server.close();
  });

  try {
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { message: "I need a pricing section", searchQuery: "pricing section" },
    });
    return { threw: null, result: result as unknown as Record<string, unknown> };
  } catch (error) {
    const failure = error as { name?: string; code?: unknown };
    return { threw: { name: failure.name ?? "Error", code: failure.code }, result: null };
  }
}

/** Every string reachable in a value, however deeply nested. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)]);
  }
  return [];
}

/**
 * The tool's text content, with any JSON payload expanded, so a forbidden
 * fragment cannot hide inside a serialized error object.
 */
function reportedStrings(result: Record<string, unknown> | null): string[] {
  const strings = stringsIn(result);
  const expanded: string[] = [...strings];
  for (const text of strings) {
    try {
      expanded.push(...stringsIn(JSON.parse(text)));
    } catch {
      // Not JSON — the plain string is already in the list.
    }
  }
  return expanded;
}

function textOf(result: Record<string, unknown> | null): string {
  const content = (result?.content ?? []) as Array<{ type?: string; text?: string }>;
  expect(Array.isArray(content)).toBe(true);
  expect(content.length).toBeGreaterThan(0);
  expect(content[0]?.type).toBe("text");
  return content[0]?.text ?? "";
}

/**
 * The whole assertion for a malformed response, in one place: the call resolved
 * (no protocol error), the tool reported the failure itself, and nothing the
 * agent receives quotes the remote or the engine.
 */
function expectReportedFailure(outcome: ToolOutcome): void {
  // Never a protocol error — this is the assertion the defect fails.
  expect(outcome.threw).toBeNull();
  expect(outcome.result).not.toBeNull();
  expect(outcome.result?.isError).toBe(true);

  const text = textOf(outcome.result);
  expect(text.length).toBeGreaterThan(0);

  for (const fragment of FORBIDDEN_FRAGMENTS) {
    for (const reported of reportedStrings(outcome.result)) {
      expect(reported).not.toContain(fragment);
    }
  }
}

describe("magic_component_inspiration — a valid body still reaches the agent", () => {
  it("CONTROL: returns the remote text verbatim, sentinel and all", async () => {
    // Non-vacuous by construction: this is the string the containment
    // assertions below look for, shown to be visible when the call succeeds.
    const baseUrl = serve(() =>
      Response.json({ text: `<Pricing/> ${SENTINEL}`, unused: "ignored" })
    );

    const outcome = await callThroughMcp(baseUrl);

    expect(outcome.threw).toBeNull();
    expect(outcome.result?.isError).toBeFalsy();
    expect(textOf(outcome.result)).toBe(`<Pricing/> ${SENTINEL}`);
  });
});

describe("magic_component_inspiration — a malformed body is reported, never a -32602", () => {
  it("reports an empty object instead of failing MCP result validation", async () => {
    const outcome = await callThroughMcp(serve(() => Response.json({})));

    expect(outcome.threw?.code).toBeUndefined();
    expectReportedFailure(outcome);
  });

  it("reports a wrong-typed `text` instead of coercing or rejecting the call", async () => {
    // Measured: `{text:123}` produces -32602 here and a silent "123" in
    // create-ui. Neither is a report.
    const outcome = await callThroughMcp(serve(() => Response.json({ text: 123 })));

    expect(outcome.threw?.code).toBeUndefined();
    expectReportedFailure(outcome);
  });

  it("reports a body that is not JSON, with no engine string attached", async () => {
    const outcome = await callThroughMcp(
      serve(() =>
        new Response(`<html>${SENTINEL}</html>`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      )
    );

    expectReportedFailure(outcome);
  });

  it("reports an interrupted connection as a failure, not as a credential problem", async () => {
    // Declared 500 bytes, 16 delivered, socket closed. No attacker is required
    // for this one — a dropped connection is enough.
    const baseUrl = serveRaw((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n" +
          '{"text":"partial'
      );
      setTimeout(() => socket.end(), 20);
    });

    const outcome = await callThroughMcp(baseUrl);

    expectReportedFailure(outcome);
  });

  it("reports an error status without quoting the remote body or status line", async () => {
    // The status line is written by hand: measured on Bun 1.3.14, `Bun.serve`
    // replaces a custom `statusText` with the canonical reason phrase, and the
    // remote status line is exactly what `logo-search` was measured echoing.
    const body = JSON.stringify({ error: SENTINEL });
    const baseUrl = serveRaw((socket) =>
      socket.write(
        `HTTP/1.1 500 ${SENTINEL}\r\n` +
          "Content-Type: application/json\r\n" +
          `x-remote-note: ${SENTINEL}\r\n` +
          `Content-Length: ${body.length}\r\n\r\n${body}`
      )
    );

    const outcome = await callThroughMcp(baseUrl);

    expectReportedFailure(outcome);
  });

  it("reports a body whose `text` is null", async () => {
    const outcome = await callThroughMcp(serve(() => Response.json({ text: null })));

    expect(outcome.threw?.code).toBeUndefined();
    expectReportedFailure(outcome);
  });
});
