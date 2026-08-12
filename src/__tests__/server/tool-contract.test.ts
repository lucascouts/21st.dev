/**
 * Contract test for the advertised tool surface (`tools/list`).
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/__tests__/tools/base-tool.test.ts` proves that `BaseTool.register()` calls
 * `server.tool(...)` — but it calls it on a *fake* server, so it can never notice
 * that the SDK changed how a Zod schema is converted into the JSON Schema that
 * clients actually receive. This file closes that gap: it drives a real
 * `McpServer` from a real `Client` over the SDK's in-memory transport and asserts
 * on the response an MCP client would really see. It is a characterization guard
 * — it is expected to pass today; its value is the *next* SDK bump.
 *
 * WHAT IS PINNED, AND WHAT DELIBERATELY IS NOT
 * --------------------------------------------
 * Pinned (R2.2/R2.3): the exact set of tool names, and per tool the input-schema
 * property names, the set of required properties, and each property's declared
 * JSON Schema `type`.
 * Deliberately NOT pinned (R2.4): every description, on the tool and on each
 * property. Prose is documentation for the model, it is tuned constantly, and a
 * guard that fights that tuning gets deleted instead of maintained. There is
 * therefore no `description` assertion anywhere in this file — and for the same
 * reason no whole-`inputSchema` snapshot, which would smuggle one back in.
 *
 * WHY IT BUILDS ITS OWN `McpServer` INSTEAD OF USING `MagicServer`
 * ---------------------------------------------------------------
 * `MagicServer.start()` constructs its `StdioServerTransport` internally
 * (`src/server.ts`), so the transport cannot be swapped for an in-memory one
 * without changing production code. This test therefore mirrors the registration
 * block of `src/server.ts` — same server identity, same tool classes, same order,
 * each registered through its own real `tool.register(server)`. It exercises the
 * real registration path and the real Zod -> JSON Schema conversion, which is the
 * whole surface under guard; what it does not cover is `MagicServer`'s DI and
 * stdio wiring, which advertises nothing. Keep this block in sync with
 * `src/server.ts` so that a drift there shows up here.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Config } from "../../config.js";
import { Logger } from "../../logger.js";
import { HttpClient } from "../../http/client.js";
import { BrowserDetector } from "../../browser/detector.js";

import { CreateUiTool } from "../../tools/create-ui.tool.js";
import { FetchUiTool } from "../../tools/fetch-ui.tool.js";
import { RefineUiTool } from "../../tools/refine-ui.tool.js";
import { LogoSearchTool } from "../../tools/logo-search.tool.js";
import { HealthCheckTool } from "../../tools/health-check.tool.js";
import { CanvasUiTool } from "../../tools/canvas-ui.tool.js";

/** A single entry of the `tools/list` response, as typed by the SDK itself. */
type AdvertisedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

interface ExpectedTool {
  /** Input-schema property name -> the JSON Schema `type` it must be declared as. */
  readonly properties: Readonly<Record<string, string>>;
  /** Exactly the properties that must appear in the schema's `required` list. */
  readonly required: readonly string[];
}

/**
 * The expected surface, transcribed from the Zod schemas declared in
 * `src/tools/*.tool.ts`. Conversions worth flagging, because they are the ones a
 * future SDK could quietly change (all verified against zod 4.4.3 + SDK 1.30.0):
 *   - `z.array(z.string())` -> `type: "array"` (the element type lives in `items`)
 *   - `z.enum([...])`       -> `type: "string"` plus an `enum` list
 *   - `.optional()`/`.default()` -> still listed in `properties`, dropped from `required`
 *   - `z.union([...])`/`.nullable()` -> **no top-level `type` at all**, only `anyOf`;
 *     if a property ever becomes a union, widen this table to `string | undefined`.
 */
const EXPECTED_TOOLS: Readonly<Record<string, ExpectedTool>> = {
  // src/tools/create-ui.tool.ts
  magic_component_builder: {
    properties: {
      message: "string",
      searchQuery: "string",
      absolutePathToCurrentFile: "string",
      standaloneRequestQuery: "string",
    },
    required: ["message", "searchQuery", "absolutePathToCurrentFile", "standaloneRequestQuery"],
  },
  // src/tools/refine-ui.tool.ts
  magic_component_refiner: {
    properties: {
      userMessage: "string",
      absolutePathToRefiningFile: "string",
      context: "string",
    },
    required: ["userMessage", "absolutePathToRefiningFile", "context"],
  },
  // src/tools/fetch-ui.tool.ts
  magic_component_inspiration: {
    properties: {
      message: "string",
      searchQuery: "string",
    },
    required: ["message", "searchQuery"],
  },
  // src/tools/logo-search.tool.ts
  magic_logo_search: {
    properties: {
      queries: "array",
      format: "string",
    },
    required: ["queries", "format"],
  },
  // src/tools/canvas-ui.tool.ts
  magic_component_canvas: {
    properties: {
      message: "string",
      standaloneRequestQuery: "string",
    },
    required: ["message", "standaloneRequestQuery"],
  },
  // src/tools/health-check.tool.ts — `z.object({})`: no properties, nothing required.
  magic_health_check: {
    properties: {},
    required: [],
  },
};

const EXPECTED_NAMES = Object.keys(EXPECTED_TOOLS);

let server: McpServer;
let client: Client;
let advertisedNames: string[] = [];
let advertisedByName = new Map<string, AdvertisedTool>();

/**
 * Real dependencies, constructed inert. None of these is a mock: `tools/list`
 * only reads each tool's `name`/`description`/`schema`, so no dependency is ever
 * invoked, and constructing the real classes keeps a stub from silently
 * satisfying a type the real dependency would not.
 */
function buildTools() {
  const logger = new Logger("error", "tool-contract-test");
  const httpClient = new HttpClient({
    // Never contacted: no tool is executed by `tools/list`.
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused-by-tools-list",
    timeout: 1,
    retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1, jitterMax: 0 },
    logger,
  });
  const browserDetector = new BrowserDetector(logger);
  const config: Config = {
    apiKey: "unused-by-tools-list",
    logLevel: "error",
    timeout: 1,
    maxFileSize: 1,
    maxBodySize: 1,
    // Never used: no tool is executed by `tools/list`. Present because
    // `Config` requires it — the confinement boundary has no default that
    // silently widens.
    allowedRoots: [process.cwd()],
    debug: false,
    canvas: false,
    github: false,
  };

  // Mirrors src/server.ts — same classes, same construction, same order.
  return [
    new CreateUiTool({ httpClient, browserDetector, logger, config }),
    new FetchUiTool({ httpClient, logger }),
    new RefineUiTool({ httpClient, logger, config }),
    new LogoSearchTool({ logger }),
    new HealthCheckTool({ httpClient, logger }),
    new CanvasUiTool({ browserDetector, logger, config }),
  ];
}

/** Fails with the tool name spelled out rather than an opaque `undefined`. */
function advertised(toolName: string): AdvertisedTool {
  const tool = advertisedByName.get(toolName);
  if (!tool) {
    throw new Error(
      `tools/list does not advertise "${toolName}". Advertised: ${advertisedNames.join(", ") || "(none)"}`
    );
  }
  return tool;
}

function propertiesOf(toolName: string): Record<string, unknown> {
  return advertised(toolName).inputSchema.properties ?? {};
}

/** `required` is omitted entirely when nothing is required (e.g. `z.object({})`). */
function requiredOf(toolName: string): string[] {
  return advertised(toolName).inputSchema.required ?? [];
}

/** Reads a property's declared `type` without assuming the property is well-formed. */
function declaredType(property: unknown): unknown {
  if (typeof property !== "object" || property === null) return undefined;
  return (property as { type?: unknown }).type;
}

describe("tools/list contract", () => {
  beforeAll(async () => {
    server = new McpServer({ name: "magic-mcp", version: "2.0.0" });
    for (const tool of buildTools()) {
      tool.register(server);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "tool-contract-test", version: "2.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    advertisedNames = tools.map((tool) => tool.name);
    advertisedByName = new Map(tools.map((tool) => [tool.name, tool]));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it("advertises exactly the six registered tool names", () => {
    // Sorted on both sides: the contract is the set, not the registration order.
    expect([...advertisedNames].sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  for (const [toolName, expected] of Object.entries(EXPECTED_TOOLS)) {
    describe(toolName, () => {
      it("advertises exactly the declared input-schema properties", () => {
        expect(Object.keys(propertiesOf(toolName)).sort()).toEqual(
          Object.keys(expected.properties).sort()
        );
      });

      it("advertises exactly the declared required properties", () => {
        expect([...requiredOf(toolName)].sort()).toEqual([...expected.required].sort());
      });

      for (const [propertyName, expectedType] of Object.entries(expected.properties)) {
        it(`declares "${propertyName}" as JSON Schema type "${expectedType}"`, () => {
          const properties = propertiesOf(toolName);
          expect(Object.keys(properties)).toContain(propertyName);
          expect(declaredType(properties[propertyName])).toBe(expectedType);
        });
      }
    });
  }
});
