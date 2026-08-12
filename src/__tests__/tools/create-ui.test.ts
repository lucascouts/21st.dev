import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CreateUiTool } from "../../tools/create-ui.tool.js";
import { HttpClient } from "../../http/client.js";
import type { BrowserDetector } from "../../browser/detector.js";
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";

/**
 * Story 006, task 1.3 — R3.1, R3.2, R3.3, R3.4. Integration tests for the FILE ACCESS
 * behaviour of `magic_component_builder`. The callback channel (`BROWSER_URL:`, the
 * `javascript:` link) is a different boundary and is covered by
 * `create-ui.channel.test.ts`; nothing here asserts on it.
 *
 * Measured 2026-08-12 on the shipped code: `fallbackToApi` calls
 * `PathValidator.validate(path, "/")`, which refuses every real path, so the tool has
 * always sent `fileContent: ""` — and the failure is swallowed by a `catch {}` whose
 * body is the comment `// ignore`, with NO log at any level. That is fail-closed and
 * completely undiagnosable, which is how a broken tool survived 398 green tests.
 * R3.3 therefore requires both halves: the caller is told, and a `warn` line names the
 * path.
 *
 * Two rules carried from story 005:
 *
 * 1. **Assert on the outbound body and on counts, never on an error message.** A message
 *    assertion passes even when the file was read and transmitted — R3.2 is exactly the
 *    property that it was not, so refusal is asserted by containment against a sentinel
 *    planted in the file outside the root.
 * 2. **Every negative test carries a positive control** — the same tool, a real file
 *    inside the root, and its content in the outbound body. The shipped tool sends an
 *    empty `fileContent` for every input, so a refusal-only assertion would pass against
 *    the defect.
 *
 * The browser is never opened: `openUrl` is stubbed to `false`, which is the tool's own
 * "browser unavailable" path and lands in the API fallback under test. `fetch` is
 * stubbed, so no host is reached.
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
const API_SENTINEL = "COMPONENT-TEXT-FROM-API";
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
  root = await realpath(await mkdtemp(path.join(tmpdir(), "magic-create-root-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "magic-create-out-")));

  fileInRoot = path.join(root, "Page.tsx");
  secretOutside = path.join(outside, "secret.env");
  symlinkInRoot = path.join(root, "Escape.tsx");
  oversizeInRoot = path.join(root, "Huge.tsx");

  await writeFile(fileInRoot, `export const Page = () => "${FILE_SENTINEL}";\n`);
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

/** The tool's own "no browser here" path — nothing is opened and nothing is spawned. */
const browserDetector = { openUrl: async () => false } as unknown as BrowserDetector;

function makeTool(overrides: Partial<Config> = {}): {
  tool: CreateUiTool;
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
    tool: new CreateUiTool({ httpClient, browserDetector, logger, config: makeConfig(overrides) }),
    logs,
  };
}

function textOf(response: { content: Array<{ text: string }> }): string {
  return response.content.map((part) => part.text).join("\n");
}

function run(tool: CreateUiTool, absolutePathToCurrentFile: string) {
  return tool.execute({
    message: "add a pricing card",
    searchQuery: "pricing card",
    absolutePathToCurrentFile,
    standaloneRequestQuery: "a pricing card for the landing page",
  });
}

/** Every `fileContent` this run put on the wire. */
function sentFileContents(record: FetchRecord): string[] {
  return record.calls.map((call) => {
    const body = call.body as { fileContent?: unknown } | undefined;
    return typeof body?.fileContent === "string" ? body.fileContent : "";
  });
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
 * The non-vacuous control: a fresh tool, a real file inside the configured root, one more
 * outbound request, and the file's content in its body. Fails against the shipped code,
 * which sends `fileContent: ""` for every input.
 */
async function controlSendsFileInRoot(): Promise<void> {
  const before = installed.calls.length;
  const { tool } = makeTool();

  const response = await run(tool, fileInRoot);

  expect(response.isError).toBeFalsy();
  expect(installed.calls).toHaveLength(before + 1);
  const body = installed.calls[before]?.body as { fileContent?: string } | undefined;
  expect(body?.fileContent).toContain(FILE_SENTINEL);
}

describe("CreateUiTool — a file inside a configured root", () => {
  it("sends its content as fileContent to the API", async () => {
    const { tool } = makeTool();

    const response = await run(tool, fileInRoot);

    expect(response.isError).toBeFalsy();
    expect(textOf(response)).toContain(API_SENTINEL);

    expect(installed.calls).toHaveLength(1);
    expect(installed.calls[0]?.url).toBe(`${BASE_URL}/api/fetch-ui`);
    const body = installed.calls[0]?.body as { fileContent?: string; searchQuery?: string };
    expect(body.fileContent).toContain(FILE_SENTINEL);
    expect(body.fileContent).not.toBe("");
    expect(body.searchQuery).toBe("pricing card");
  });
});

describe("CreateUiTool — a path outside every configured root", () => {
  it("reports the failure, logs it at warn, and sends no file content", async () => {
    const { tool, logs } = makeTool();

    const response = await run(tool, secretOutside);

    expect(response.isError).toBe(true);
    expect(sentFileContents(installed).every((content) => content === "")).toBe(true);
    expect(JSON.stringify(installed.calls)).not.toContain(SECRET_SENTINEL);

    const warned = logs.filter(
      (entry) => entry.level === "warn" && entry.text.includes(secretOutside)
    );
    expect(warned.length).toBeGreaterThan(0);

    await controlSendsFileInRoot();
  });

  it("does not read a file reached through a symlink that leaves the root", async () => {
    const { tool, logs } = makeTool();

    const response = await run(tool, symlinkInRoot);

    expect(response.isError).toBe(true);
    expect(sentFileContents(installed).every((content) => content === "")).toBe(true);
    expect(JSON.stringify(installed.calls)).not.toContain(SECRET_SENTINEL);

    const warned = logs.filter(
      (entry) => entry.level === "warn" && entry.text.includes(symlinkInRoot)
    );
    expect(warned.length).toBeGreaterThan(0);

    await controlSendsFileInRoot();
  });
});

describe("CreateUiTool — the size bound", () => {
  it("never puts a file larger than maxFileSize on the wire", async () => {
    const { tool } = makeTool({ maxFileSize: 64 });

    await run(tool, oversizeInRoot);

    expect(JSON.stringify(installed.calls)).not.toContain(OVERSIZE_SENTINEL);
    for (const content of sentFileContents(installed)) {
      expect(content.length).toBeLessThanOrEqual(64);
    }

    await controlSendsFileInRoot();
  });
});
