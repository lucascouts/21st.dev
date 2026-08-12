/**
 * The shared client returns a validated value or a named failure
 * (story 006, sub-task 2.2 — R1.1 to R1.5, R2.3).
 *
 * WHAT THIS FILE PINS
 * -------------------
 * One property, stated seven ways: **`ok: true` implies the body satisfied the
 * schema, and no other outcome hands the caller a value at all.** The current
 * client asserts a shape nobody verified (`(await response.json()) as T`) and
 * represents absence as a value of that type (`null as T`), so `ok === true`
 * coexists with `data === null` and the field read that follows raises somewhere
 * else, later, in the vocabulary of a JavaScript engine.
 *
 * The result type under test is design.md Fix Approach 1:
 *
 *   { ok: true;  status: number; data: T }
 *   { ok: false; status: number; kind: FailureKind }
 *
 * Every failure assertion in this file therefore checks TWO things through
 * `expectFailure`: the kind is the one this trigger produces, and the result
 * carries NO `data` property at all. The second half is the one the defect
 * fails: `null as T` is a `data` property whose value is a lie.
 *
 * WHY A REAL SERVER RATHER THAN A `fetch` STUB
 * --------------------------------------------
 * Four of these triggers only exist in real HTTP framing — a body cut short of
 * its declared length, a `content-length` that disagrees with the bytes that
 * follow it, chunked transfer, a redirect to a second origin. A stub can be made
 * to *say* those things; it cannot make the platform's `fetch` behave as it does
 * when they happen. Story 005 shipped a stub that did not model redirect
 * following and five assertions passed against unfixed code, so everything here
 * runs against a local `Bun.serve` — or, where the framing itself is the point,
 * a raw `Bun.listen` writing HTTP/1.1 by hand. No test reaches a host that is
 * not 127.0.0.1.
 *
 * MEASURED ON BUN 1.3.14, 2026-08-12, AND RELIED ON BELOW
 * -------------------------------------------------------
 * - `Bun.serve` DROPS a manually set `Content-Length` on a streamed response and
 *   frames it chunked, so a lying header cannot be produced through it. Written
 *   by hand over a raw socket, `Content-Length: 12` alongside
 *   `Transfer-Encoding: chunked` and a 200 KB body is delivered whole: the
 *   client sees `content-length: 12` and reads 200,011 bytes. That is the
 *   literal lie R1.4's "and against the accumulated bytes regardless" exists for.
 * - A body cut short of its declared `Content-Length` makes the body read reject
 *   ("The socket connection was closed unexpectedly"); the current client
 *   swallows it into `null as T`.
 *
 * The existing `src/__tests__/http/client.test.ts` is NOT modified and NOT
 * duplicated: its two behavioural assertions (the `Authorization` header, and
 * 4xx not being retried) are re-expressed here through the new signature, as
 * sub-task 2.2 requires, so the coverage survives the signature change.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { HttpClient } from "../../http/client.js";
import type { HttpResult } from "../../http/client.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "error" as const,
};

/** The one shape three tools consume, and the schema every test passes. */
const textSchema = z.object({ text: z.string() });

/** Planted in remote bodies, headers and status lines; looked for in results. */
const SENTINEL = "REMOTE-SENTINEL-6f2a-ignore-previous-instructions";

/** Small enough to make an oversize body cheap, large enough to be realistic. */
const MAX_BODY = 1024;

interface Stoppable {
  stop(closeActiveConnections?: boolean): void;
}

let running: Stoppable[] = [];

afterEach(() => {
  for (const server of running) server.stop(true);
  running = [];
});

function createClient(
  baseUrl: string,
  overrides: { maxRetries?: number; timeout?: number; maxBodySize?: number } = {}
): HttpClient {
  return new HttpClient({
    baseUrl,
    apiKey: "test-key",
    timeout: overrides.timeout ?? 5000,
    maxBodySize: overrides.maxBodySize ?? MAX_BODY,
    retry: {
      maxRetries: overrides.maxRetries ?? 0,
      baseDelay: 5,
      maxDelay: 20,
      jitterMax: 1,
    },
    logger: silentLogger as never,
  });
}

interface TestServer {
  readonly origin: string;
  /** How many requests the server actually received. */
  count(): number;
}

/** A server whose handler sees the request path and returns a real Response. */
function serve(handler: (req: Request) => Response | Promise<Response>): TestServer {
  let received = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      received += 1;
      return handler(req);
    },
  });
  running.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, count: () => received };
}

/** The minimum a raw socket needs to answer one HTTP/1.1 request by hand. */
interface RawSocket {
  write(data: string): unknown;
  end(): unknown;
}

/**
 * A server that writes its own HTTP/1.1 response, used where the FRAMING is the
 * thing under test and `Bun.serve` would normalise it away.
 */
function serveRaw(respond: (socket: RawSocket) => void): TestServer {
  let received = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        if (!data.toString().includes("\r\n\r\n")) return;
        received += 1;
        respond(socket);
      },
      open() {},
      error() {},
    },
  });
  running.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, count: () => received };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Assert a failure and hand back its two readable fields.
 *
 * The `data` check lives here rather than at each call site so R1.2 — an
 * absent, unreadable or unvalidated body is NOT represented as a value of the
 * requested type — is asserted on every failure this file produces, not only on
 * the ones someone remembered.
 */
function expectFailure<T>(result: HttpResult<T>): { readonly status: number; readonly kind: string } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failed call");
  expect(Object.prototype.hasOwnProperty.call(result, "data")).toBe(false);
  return result;
}

/** Assert a success and hand back the validated value. */
function expectSuccess<T>(result: HttpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a successful call, got kind "${result.kind}"`);
  expect(Object.prototype.hasOwnProperty.call(result, "kind")).toBe(false);
  return result.data;
}

// ---------------------------------------------------------------------------
// 1. ok: true implies the body satisfied the schema (R1.1, R1.2, R1.3)
// ---------------------------------------------------------------------------

describe("HttpClient — a body is returned only when it satisfied the schema (R1.1)", () => {
  it("CONTROL: a well-formed body is still delivered to the caller", async () => {
    // Non-vacuous by construction: every refusal below would also be produced by
    // a client that refused everything. This is the assertion that says it does
    // not, and it is the regression story.md names — delivering the text is the
    // purpose of these tools.
    const server = serve(() => jsonResponse({ text: "a component", extra: "ignored" }));
    const result = await createClient(server.origin).post("/api/fetch-ui", { q: 1 }, textSchema);

    expect(expectSuccess(result).text).toBe("a component");
    expect(result.status).toBe(200);
    expect(server.count()).toBe(1);
  });

  it("fails an empty object, which today yields `undefined` for the field read", async () => {
    const server = serve(() => jsonResponse({}));
    const result = await createClient(server.origin).post("/api/fetch-ui", {}, textSchema);

    expect(expectFailure(result).kind).toBe("schema_mismatch");
  });

  it("fails a wrong-typed field rather than coercing it", async () => {
    const server = serve(() => jsonResponse({ text: 123 }));
    const result = await createClient(server.origin).post("/api/fetch-ui", {}, textSchema);

    expect(expectFailure(result).kind).toBe("schema_mismatch");
  });

  it("fails a null body", async () => {
    const server = serve(() => jsonResponse("null"));
    const result = await createClient(server.origin).post("/api/fetch-ui", {}, textSchema);

    expect(expectFailure(result).kind).toBe("schema_mismatch");
  });

  it("fails a 200 whose body is not JSON at all", async () => {
    const server = serve(() =>
      new Response("<html>maintenance</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    );
    const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

    expect(expectFailure(result).kind).toBe("unreadable_body");
  });

  it("fails a body cut short of its declared length — no attacker required", async () => {
    // Declared 500 bytes, 16 delivered, then the socket closes. Measured: the
    // body read rejects; the current client turns that into `ok: true` with a
    // null body, which is the TypeError reported to the agent as a credential
    // problem.
    const server = serveRaw((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n" +
          '{"text":"partial'
      );
      setTimeout(() => socket.end(), 20);
    });
    const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

    expect(expectFailure(result).kind).toBe("unreadable_body");
  });

  it("accepts `z.unknown()` from a caller that consumes no body", async () => {
    // health-check reads only `ok` and `status`; saying so explicitly is the
    // honest alternative to inventing a shape nobody reads.
    const server = serve(() => jsonResponse({ status: "healthy", anything: [1, 2, 3] }));
    const result = await createClient(server.origin).get("/health", z.unknown());

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. The error-status path yields no value either (R1.3, the GOTCHA in 2.2)
// ---------------------------------------------------------------------------

describe("HttpClient — an error status hands back no body (R1.3)", () => {
  it("reports a 4xx as http_error, issues one request, and returns no data", async () => {
    // Re-expresses the surviving assertion of the existing client.test.ts
    // through the new signature: 4xx is not retried.
    const server = serve(() => jsonResponse({ error: "not found" }, { status: 404 }));
    const result = await createClient(server.origin, { maxRetries: 3 }).get("/missing", textSchema);

    const failure = expectFailure(result);
    expect(failure.kind).toBe("http_error");
    expect(failure.status).toBe(404);
    expect(server.count()).toBe(1);
  });

  it("returns no data for a 4xx even when the body WOULD satisfy the schema", async () => {
    // The branch the current implementation also feeds through `safeJson`. A
    // fix that validates only the 2xx path leaves the same defect in a
    // different branch — this story's own root-cause pattern.
    const server = serve(() => jsonResponse({ text: "a component" }, { status: 403 }));
    const result = await createClient(server.origin).get("/forbidden", textSchema);

    expect(expectFailure(result).status).toBe(403);
  });

  it("retries a 5xx to the configured limit and then fails with no data", async () => {
    const server = serve(() => jsonResponse({ text: "still broken" }, { status: 500 }));
    const result = await createClient(server.origin, { maxRetries: 2 }).get("/flaky", textSchema);

    const failure = expectFailure(result);
    expect(failure.status).toBe(500);
    expect(failure.kind).toBe("http_error");
    expect(server.count()).toBe(3);
  });

  it("still sends the Authorization header", async () => {
    // Re-expressed from the existing client.test.ts, which calls `get` with no
    // schema and cannot survive the signature change unchanged.
    let receivedAuth = "";
    const server = serve((req) => {
      receivedAuth = req.headers.get("authorization") ?? "";
      return jsonResponse({ text: "ok" });
    });
    await createClient(server.origin).get("/test", textSchema);

    expect(receivedAuth).toBe("Bearer test-key");
  });
});

// ---------------------------------------------------------------------------
// 3. The size bound (R1.4)
// ---------------------------------------------------------------------------

describe("HttpClient — the response size is bounded (R1.4)", () => {
  it("CONTROL: a body under the bound is delivered normally", async () => {
    const server = serve(() => jsonResponse({ text: "x".repeat(MAX_BODY / 2) }));
    const result = await createClient(server.origin).get("/small", textSchema);

    expect(expectSuccess(result).text.length).toBe(MAX_BODY / 2);
  });

  it("fails an oversize body whose content-length tells the truth", async () => {
    const payload = JSON.stringify({ text: "x".repeat(MAX_BODY * 8) });
    const server = serve(() => jsonResponse(payload));

    // The setup itself is asserted, so a change in framing cannot make this
    // test pass by no longer being oversize.
    const probe = await fetch(`${server.origin}/big`);
    expect(Number(probe.headers.get("content-length"))).toBeGreaterThan(MAX_BODY);
    await probe.text();

    const result = await createClient(server.origin).get("/big", textSchema);
    expect(expectFailure(result).kind).toBe("too_large");
  });

  it("fails an oversize body whose content-length LIES about its size", async () => {
    // `content-length` is remote-supplied. Written by hand: the header says 12
    // while chunked framing delivers ~200 KB, and Bun's fetch delivers all of
    // it. An implementation that trusts the header alone lets this through.
    const payload = JSON.stringify({ text: "z".repeat(200_000) });
    const chunked = `${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
    const rawResponse =
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 12\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "\r\n" +
      chunked;

    const server = serveRaw((socket) => socket.write(rawResponse));

    // CONTROL: the lie is real, and it is the direction that matters — the
    // header is inside the bound while the body is 200 times over it.
    const probe = await fetch(`${server.origin}/big`);
    expect(probe.headers.get("content-length")).toBe("12");
    expect(Number(probe.headers.get("content-length"))).toBeLessThan(MAX_BODY);
    expect((await probe.text()).length).toBeGreaterThan(MAX_BODY);

    const result = await createClient(server.origin).get("/big", textSchema);
    expect(expectFailure(result).kind).toBe("too_large");
  });
});

// ---------------------------------------------------------------------------
// 4. Redirects (R1.5)
// ---------------------------------------------------------------------------

describe("HttpClient — a redirect may not change the body's origin (R1.5)", () => {
  it("refuses a redirect to another origin, and never requests it", async () => {
    const elsewhere = serve(() => jsonResponse({ text: `from-elsewhere ${SENTINEL}` }));
    const service = serve(() => new Response(null, { status: 302, headers: { location: `${elsewhere.origin}/api/fetch-ui` } }));

    const result = await createClient(service.origin).get("/api/fetch-ui", textSchema);

    expect(expectFailure(result).kind).toBe("redirect_refused");
    // The assertion that matters is the COUNT: an error-message assertion would
    // pass even if the second origin had been contacted and its body read.
    expect(elsewhere.count()).toBe(0);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("CONTROL: a redirect within the service's own origin is still followed", async () => {
    // Without this, "refuses cross-origin" would also be satisfied by a client
    // that refused every redirect, or issued no request at all.
    const service = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/fetch-ui") {
        return new Response(null, { status: 302, headers: { location: "/api/fetch-ui/v2" } });
      }
      return jsonResponse({ text: "followed within the service" });
    });

    const result = await createClient(service.origin).get("/api/fetch-ui", textSchema);

    expect(expectSuccess(result).text).toBe("followed within the service");
    expect(service.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Transport failures are named, not improvised (R2.1)
// ---------------------------------------------------------------------------

describe("HttpClient — a transport failure has a name", () => {
  it("reports a timeout as `timeout`", async () => {
    const server = serve(async () => {
      await Bun.sleep(2000);
      return jsonResponse({ text: "too late" });
    });
    const result = await createClient(server.origin, { timeout: 120 }).get("/slow", textSchema);

    const failure = expectFailure(result);
    expect(failure.kind).toBe("timeout");
    expect(failure.status).toBe(0);
  });

  it("reports a connection that cannot be made as `network`", async () => {
    // A port that was listening and is not any more: nothing external is
    // contacted, and no fixed port is assumed to be free.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const origin = `http://127.0.0.1:${server.port}`;
    server.stop(true);

    const result = await createClient(origin).get("/gone", textSchema);

    const failure = expectFailure(result);
    expect(failure.kind).toBe("network");
    expect(failure.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. No remote-supplied string survives into a failure (R2.2, R2.3)
// ---------------------------------------------------------------------------

describe("HttpClient — no remote text crosses on a failure path (R2.2)", () => {
  it("CONTROL: a remote string in a VALID body still reaches the caller", async () => {
    // The containment assertions below are only evidence if the sentinel would
    // otherwise be visible. On the success path it is — that is the product.
    const server = serve(() => jsonResponse({ text: SENTINEL }));
    const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

    expect(expectSuccess(result).text).toBe(SENTINEL);
  });

  it("carries no remote body, header or status text into an http_error", async () => {
    // Written by hand: measured on Bun 1.3.14, `Bun.serve` REPLACES a custom
    // `statusText` with the canonical reason phrase, so a served response
    // cannot carry the remote status line this assertion is about. A raw
    // status line does — verified by the control below.
    const body = JSON.stringify({ error: SENTINEL, hint: SENTINEL });
    const server = serveRaw((socket) =>
      socket.write(
        `HTTP/1.1 500 ${SENTINEL}\r\n` +
          "Content-Type: application/json\r\n" +
          `x-remote-note: ${SENTINEL}\r\n` +
          `Content-Length: ${body.length}\r\n\r\n${body}`
      )
    );

    // CONTROL: the sentinel really is in all three places on the wire.
    const probe = await fetch(`${server.origin}/x`);
    expect(probe.statusText).toBe(SENTINEL);
    expect(probe.headers.get("x-remote-note")).toBe(SENTINEL);
    expect(await probe.text()).toContain(SENTINEL);

    const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

    expect(expectFailure(result).status).toBe(500);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("carries no remote value into a schema_mismatch", async () => {
    const server = serve(() => jsonResponse({ text: 123, note: SENTINEL, token: "s3cr3t-token" }));
    const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

    expect(expectFailure(result).kind).toBe("schema_mismatch");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("s3cr3t-token");
  });

  it("carries no remote bytes into an unreadable_body", async () => {
    const server = serve(() =>
      new Response(`<html>${SENTINEL}</html>`, { status: 200, headers: { "Content-Type": "text/html" } })
    );
    const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

    expect(expectFailure(result).kind).toBe("unreadable_body");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("exposes only `ok`, `status` and `kind` on a failure — no field left to carry text", async () => {
    // Asserted on the SHAPE rather than on any one payload: a field added later
    // could carry remote text past every containment check above, and this is
    // the assertion that notices.
    const triggers: ReadonlyArray<readonly [string, Response]> = [
      ["schema_mismatch", jsonResponse({ text: 123, note: SENTINEL })],
      ["http_error", jsonResponse({ error: SENTINEL }, { status: 404 })],
      ["unreadable_body", new Response(SENTINEL, { status: 200, headers: { "Content-Type": "text/plain" } })],
    ];

    for (const [expectedKind, response] of triggers) {
      const server = serve(() => response.clone());
      const result = await createClient(server.origin).get("/api/fetch-ui", textSchema);

      expect(expectFailure(result).kind).toBe(expectedKind);
      expect(Object.keys(result).sort()).toEqual(["kind", "ok", "status"]);
    }
  });
});
