import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RefineUiTool } from "../../tools/refine-ui.tool.js";
import { HttpClient } from "../../http/client.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";

/**
 * Story 006, task 1.3 — R3.1, R3.2, R3.3, R3.4. Integration tests for
 * `magic_component_refiner`, driven through `execute` with the real `HttpClient` and a
 * counting `fetch` stub. No host is reached and no browser is opened.
 *
 * This tool has never worked in any released 2.x version. Measured 2026-08-12: it calls
 * `PathValidator.validate(path, "/")`, the prefix under test is `"//"`, so EVERY real
 * path is refused and the tool returns an error before any I/O — blaming the API key.
 * The first test below is story 006's Success Criterion 1, and it is the one assertion
 * that proves the tool does its advertised job rather than that a diff looks right.
 *
 * Two rules carried from story 005, both earned:
 *
 * 1. **Count outbound requests; never assert on an error message.** A message assertion
 *    passes even when the forbidden request was issued — and here the forbidden request
 *    carries the contents of a file outside the configured roots to a remote endpoint
 *    (R3.2). Refusal is therefore asserted as `calls.length === 0`, plus containment
 *    against a sentinel planted in the file.
 * 2. **Every negative test carries a positive control.** The shipped tool errors on every
 *    input, so a refusal-only assertion would pass against the defect. Each negative test
 *    below finishes by refining a real file inside the root and asserting exactly one
 *    outbound request carrying its content.
 */

interface FetchCall {
  readonly url: string;
  readonly body: unknown;
}

interface FetchRecord {
  readonly calls: FetchCall[];
  restore(): void;
}

/** Replaces global fetch with a stub recording every URL and JSON body it is given. */
function installFetch(handler: (url: string) => Response): FetchRecord {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body });
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

interface CapturedLog {
  readonly level: string;
  readonly text: string;
}

function createLogger(sink: CapturedLog[]): Logger {
  const record = (level: string) => (...args: unknown[]) => {
    sink.push({
      level,
      text: args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    getLevel: () => "debug" as const,
  } as unknown as Logger;
}

const BASE_URL = "https://api.example.invalid";
const API_SENTINEL = "REFINED-COMPONENT-FROM-API";
const FILE_SENTINEL = "MARKER-INSIDE-THE-ALLOWED-ROOT";
const SECRET_SENTINEL = "SECRET-OUTSIDE-THE-ALLOWED-ROOT";
const OVERSIZE_SENTINEL = "OVERSIZE-FILE-CONTENT";

let root: string;
let outside: string;
let fileInRoot: string;
let secretOutside: string;
let symlinkInRoot: string;
let oversizeInRoot: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "magic-refine-root-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "magic-refine-out-")));

  fileInRoot = path.join(root, "Button.tsx");
  secretOutside = path.join(outside, "secret.env");
  symlinkInRoot = path.join(root, "Escape.tsx");
  oversizeInRoot = path.join(root, "Huge.tsx");

  await writeFile(fileInRoot, `export const Button = () => "${FILE_SENTINEL}";\n`);
  await writeFile(secretOutside, `TOKEN=${SECRET_SENTINEL}\n`);
  await symlink(secretOutside, symlinkInRoot);
  await writeFile(oversizeInRoot, `// ${OVERSIZE_SENTINEL}\n${"x".repeat(4096)}\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test-api-key",
    logLevel: "debug",
    timeout: 5_000,
    maxFileSize: 1_048_576,
    maxBodySize: 1_048_576,
    debug: false,
    canvas: false,
    github: false,
    allowedRoots: [root],
    ...overrides,
  };
}

function makeTool(overrides: Partial<Config> = {}): {
  tool: RefineUiTool;
  logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  const logger = createLogger(logs);
  const httpClient = new HttpClient({
    baseUrl: BASE_URL,
    apiKey: "test-api-key",
    timeout: 5_000,
    retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1, jitterMax: 0 },
    logger,
  });
  return {
    tool: new RefineUiTool({ httpClient, logger, config: makeConfig(overrides) }),
    logs,
  };
}

function textOf(response: { content: Array<{ text: string }> }): string {
  return response.content.map((part) => part.text).join("\n");
}

let installed: FetchRecord;

beforeEach(() => {
  installed = installFetch(
    () =>
      new Response(JSON.stringify({ text: API_SENTINEL }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
});

afterEach(() => {
  installed.restore();
});

/**
 * The non-vacuous control: a fresh tool, a real file inside the configured root, exactly
 * one outbound request, and the file's content in its body. Fails against the shipped
 * code, which refuses every path.
 */
async function controlRefinesFileInRoot(): Promise<void> {
  const before = installed.calls.length;
  const { tool } = makeTool();

  const response = await tool.execute({
    userMessage: "make the button rounder",
    absolutePathToRefiningFile: fileInRoot,
    context: "the Button component",
  });

  expect(response.isError).toBeFalsy();
  expect(textOf(response)).toContain(API_SENTINEL);
  expect(installed.calls).toHaveLength(before + 1);
  const body = installed.calls[before]?.body as { fileContent?: string } | undefined;
  expect(body?.fileContent).toContain(FILE_SENTINEL);
}

describe("RefineUiTool — a file inside a configured root", () => {
  it("refines it and sends its content to the refine endpoint", async () => {
    const { tool } = makeTool();

    const response = await tool.execute({
      userMessage: "make the button rounder",
      absolutePathToRefiningFile: fileInRoot,
      context: "the Button component",
    });

    expect(response.isError).toBeFalsy();
    expect(textOf(response)).toContain(API_SENTINEL);

    expect(installed.calls).toHaveLength(1);
    expect(installed.calls[0]?.url).toBe(`${BASE_URL}/api/refine-ui`);
    const body = installed.calls[0]?.body as {
      fileContent?: string;
      userMessage?: string;
      context?: string;
    };
    expect(body.fileContent).toContain(FILE_SENTINEL);
    expect(body.userMessage).toBe("make the button rounder");
    expect(body.context).toBe("the Button component");
  });
});

describe("RefineUiTool — a path outside every configured root", () => {
  it("fails the call and issues no outbound request", async () => {
    const { tool } = makeTool();

    const response = await tool.execute({
      userMessage: "refine this",
      absolutePathToRefiningFile: secretOutside,
      context: "",
    });

    expect(response.isError).toBe(true);
    expect(installed.calls).toHaveLength(0);
    expect(JSON.stringify(installed.calls)).not.toContain(SECRET_SENTINEL);

    await controlRefinesFileInRoot();
  });

  it("does not transmit a file reached through a symlink that leaves the root", async () => {
    const { tool } = makeTool();

    const response = await tool.execute({
      userMessage: "refine this",
      absolutePathToRefiningFile: symlinkInRoot,
      context: "",
    });

    expect(response.isError).toBe(true);
    expect(installed.calls).toHaveLength(0);
    expect(JSON.stringify(installed.calls)).not.toContain(SECRET_SENTINEL);

    await controlRefinesFileInRoot();
  });

  it("refuses a traversal path built from the root", async () => {
    const { tool } = makeTool();

    const response = await tool.execute({
      userMessage: "refine this",
      absolutePathToRefiningFile: `${root}/../${path.basename(outside)}/secret.env`,
      context: "",
    });

    expect(response.isError).toBe(true);
    expect(installed.calls).toHaveLength(0);
    expect(JSON.stringify(installed.calls)).not.toContain(SECRET_SENTINEL);

    await controlRefinesFileInRoot();
  });
});

describe("RefineUiTool — the size bound", () => {
  it("refuses a file larger than maxFileSize and issues no outbound request", async () => {
    const { tool } = makeTool({ maxFileSize: 64 });

    const response = await tool.execute({
      userMessage: "refine this",
      absolutePathToRefiningFile: oversizeInRoot,
      context: "",
    });

    expect(response.isError).toBe(true);
    expect(installed.calls).toHaveLength(0);
    expect(JSON.stringify(installed.calls)).not.toContain(OVERSIZE_SENTINEL);

    await controlRefinesFileInRoot();
  });
});
