/**
 * The callback body is validated before the waiter is resolved (R4.3 — task 3.2).
 *
 * A SIBLING OF `callback-server.test.ts`, NOT A REPLACEMENT. That file pins the
 * transport-level behaviour (a port is returned, a POST is answered, the timeout
 * fires). This one pins what may become a resolved value, which is a different
 * question and belongs in its own file.
 *
 * WHAT IS PINNED
 * --------------
 * 1. **A schema-valid body still resolves.** The control for everything else: a
 *    file that only listed refusals would be satisfied by a server that resolves
 *    nothing at all, which is a denial of service dressed as a fix.
 * 2. **A rejected body LEAVES THE WINDOW OPEN.** The waiter is single-use — it
 *    resolves once and the server stops — so a refusal that consumed it would
 *    turn every hostile or malformed POST into a way to kill the user's own
 *    flow. Each refusal case below is therefore followed by a legitimate POST
 *    that MUST still be delivered, and the assertion is on the value the waiter
 *    resolved with, not on the refusal's status text.
 * 3. **A raw body never becomes the resolved value.** Measured 2026-08-12: a
 *    plain loopback POST with no `Origin` returned `200 success` and its payload
 *    reached the agent byte-identical. Every case asserts that the refused
 *    body's own marker is absent from what the waiter resolved with.
 * 4. **The measured size bound still holds** (regression: `content-length` and
 *    the read body were both measured working).
 *
 * THE PAYLOAD ENVELOPE IS PART OF THE CONTRACT THIS FILE PINS. design.md
 * requires "a schema for the callback payload" without fixing its fields, so
 * `validPayload()` below states the envelope: a JSON OBJECT. The one property
 * that must hold whatever the field names are — and the reason the envelope
 * cannot be a bare string — is item 3: `<<< not json …>>>` is a body no
 * object-shaped schema can accept. If the implemented `CallbackPayload` names
 * different fields, change `validPayload()` here; do NOT make the schema accept
 * a bare string, which would reinstate exactly the defect this task closes.
 * Every field carries the same sentinel so the assertions hold whichever field
 * a consumer ends up rendering.
 *
 * ORIGIN, NOT AUTHENTICATION. The valid POSTs below carry
 * `Origin: https://21st.dev`, which any local process can also set (story.md
 * Assumption 3). Nothing here asserts the callback is authenticated.
 *
 * All I/O is to `127.0.0.1` on an ephemeral port. No external host is reached.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { CallbackServer } from "../../callback/callback-server.js";
import { CorsHandler } from "../../callback/cors.js";
import { RateLimiter } from "../../security/rate-limiter.js";

const ISSUING_ORIGIN = "https://21st.dev";

/** How long a waiter stays open in these tests. Bounds a hang to a failure. */
const WAIT_MS = 5_000;

/** Per-test bun timeout: WAIT_MS plus room for start-up and the extra POSTs. */
const TEST_TIMEOUT_MS = 15_000;

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "debug" as const,
} as unknown as import("../../logger.js").Logger;

/**
 * A body a callback payload schema must accept. Same sentinel in every field so
 * an assertion holds whichever field the schema keeps.
 */
function validPayload(sentinel: string): string {
  return JSON.stringify({ text: sentinel, component: sentinel, code: sentinel, props: {} });
}

/** A body no object-shaped schema can accept: it is not even JSON. */
const UNPARSEABLE_MARKER = "UNPARSEABLE-CALLBACK-MARKER";
const UNPARSEABLE_BODY = `<<< ${UNPARSEABLE_MARKER} — not json, not a payload >>>`;

/** Reads the resolved value without assuming it stayed a raw string. */
function asText(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

interface Started {
  readonly server: CallbackServer;
  readonly port: number;
}

let started: Started[] = [];
let rateLimiters: RateLimiter[] = [];

async function startServer(maxBodySize = 1_048_576): Promise<Started> {
  const rateLimiter = new RateLimiter();
  rateLimiters.push(rateLimiter);
  const server = new CallbackServer({
    maxBodySize,
    cors: CorsHandler,
    rateLimiter,
    logger: mockLogger,
  });
  const port = await server.start();
  const record = { server, port };
  started.push(record);
  return record;
}

/** A POST as the issuing page makes it: a browser always sends `Origin`. */
function postFromIssuer(port: number, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ISSUING_ORIGIN },
    body,
  });
}

/** A POST with no `Origin` at all — what a non-browser local process sends. */
function postWithoutOrigin(port: number, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function postFromOrigin(port: number, origin: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body,
  });
}

afterEach(() => {
  for (const { server } of started) server.cancel();
  started = [];
  for (const rateLimiter of rateLimiters) rateLimiter.stopCleanup();
  rateLimiters = [];
});

describe("CallbackServer payload validation", () => {
  it(
    "resolves the waiter with a schema-valid body from the issuing origin",
    async () => {
      // The control. Every refusal below is only meaningful because this holds.
      const { server, port } = await startServer();
      const waiter = server.waitForCallback(WAIT_MS);

      const response = await postFromIssuer(port, validPayload("VALID-PAYLOAD-SENTINEL"));
      expect(response.status).toBe(200);

      const result = await waiter;
      expect(result.ok).toBe(true);
      expect(asText(result.ok ? result.data : undefined)).toContain("VALID-PAYLOAD-SENTINEL");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "does not resolve on a body that fails the schema, and leaves the window open",
    async () => {
      const { server, port } = await startServer();
      const waiter = server.waitForCallback(WAIT_MS);

      const refused = await postFromIssuer(port, UNPARSEABLE_BODY);
      // Not acknowledged as success: a body that was not accepted must not be
      // answered as though it had been.
      expect(refused.ok).toBe(false);

      // The single-use window must survive the refusal — otherwise a malformed
      // POST is a denial of service against the user's own callback.
      const accepted = await postFromIssuer(port, validPayload("AFTER-REFUSAL-SENTINEL"));
      expect(accepted.status).toBe(200);

      const result = await waiter;
      expect(result.ok).toBe(true);
      const resolved = asText(result.ok ? result.data : undefined);
      expect(resolved).toContain("AFTER-REFUSAL-SENTINEL");
      expect(resolved).not.toContain(UNPARSEABLE_MARKER);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "does not resolve on a POST that carries no Origin, and leaves the window open",
    async () => {
      const { server, port } = await startServer();
      const waiter = server.waitForCallback(WAIT_MS);

      const refused = await postWithoutOrigin(port, validPayload("ORIGINLESS-MARKER"));
      expect(refused.status).toBe(403);

      const accepted = await postFromIssuer(port, validPayload("AFTER-ORIGINLESS-SENTINEL"));
      expect(accepted.status).toBe(200);

      const result = await waiter;
      expect(result.ok).toBe(true);
      const resolved = asText(result.ok ? result.data : undefined);
      expect(resolved).toContain("AFTER-ORIGINLESS-SENTINEL");
      expect(resolved).not.toContain("ORIGINLESS-MARKER");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "does not resolve on a POST from an arbitrary localhost origin",
    async () => {
      // A page on the user's own dev server, possibly running third-party
      // JavaScript, is not the page we sent the user to.
      const { server, port } = await startServer();
      const waiter = server.waitForCallback(WAIT_MS);

      const refused = await postFromOrigin(
        port,
        "http://localhost:3000",
        validPayload("LOCALHOST-MARKER")
      );
      expect(refused.status).toBe(403);

      const accepted = await postFromIssuer(port, validPayload("AFTER-LOCALHOST-SENTINEL"));
      expect(accepted.status).toBe(200);

      const result = await waiter;
      expect(result.ok).toBe(true);
      const resolved = asText(result.ok ? result.data : undefined);
      expect(resolved).toContain("AFTER-LOCALHOST-SENTINEL");
      expect(resolved).not.toContain("LOCALHOST-MARKER");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "refuses an oversize body and leaves the window open (regression)",
    async () => {
      // The measured bound, kept: `content-length` and the read body were both
      // enforced before this story and must stay enforced after it.
      const { server, port } = await startServer(512);
      const waiter = server.waitForCallback(WAIT_MS);

      const refused = await postFromIssuer(port, validPayload("X".repeat(4096)));
      expect(refused.status).toBe(413);

      const accepted = await postFromIssuer(port, validPayload("AFTER-OVERSIZE-SENTINEL"));
      expect(accepted.status).toBe(200);

      const result = await waiter;
      expect(result.ok).toBe(true);
      expect(asText(result.ok ? result.data : undefined)).toContain("AFTER-OVERSIZE-SENTINEL");
    },
    TEST_TIMEOUT_MS
  );
});
