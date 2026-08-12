import { describe, it, expect, afterEach } from "bun:test";
import { CallbackServer } from "../../callback/callback-server.js";
import { CorsHandler } from "../../callback/cors.js";
import { RateLimiter } from "../../security/rate-limiter.js";

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "debug" as const,
} as any;

function createTestServer() {
  return new CallbackServer({
    maxBodySize: 1_048_576,
    cors: CorsHandler,
    rateLimiter: new RateLimiter(),
    logger: mockLogger,
  });
}

describe("CallbackServer", () => {
  let server: CallbackServer | null = null;
  let rateLimiters: RateLimiter[] = [];

  afterEach(() => {
    if (server) {
      server.cancel();
      server = null;
    }
    for (const rl of rateLimiters) {
      rl.stopCleanup();
    }
    rateLimiters = [];
  });

  it("start() returns a valid port number > 0", async () => {
    const rl = new RateLimiter();
    rateLimiters.push(rl);
    server = new CallbackServer({
      maxBodySize: 1_048_576,
      cors: CorsHandler,
      rateLimiter: rl,
      logger: mockLogger,
    });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(typeof port).toBe("number");
  });

  it("POST request resolves with callback data", async () => {
    const rl = new RateLimiter();
    rateLimiters.push(rl);
    server = new CallbackServer({
      maxBodySize: 1_048_576,
      cors: CorsHandler,
      rateLimiter: rl,
      logger: mockLogger,
    });
    const port = await server.start();

    const callbackPromise = server.waitForCallback(5000);

    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      // The issuing origin, sent explicitly. This test is about a POST
      // RESOLVING the waiter; it used to omit `Origin` entirely and pass only
      // because an absent origin was treated as permission — the R4.1 defect
      // story 006 removes. Sending the origin a real browser would send keeps
      // the test on its own subject.
      headers: { "Content-Type": "application/json", Origin: "https://21st.dev" },
      body: JSON.stringify({ component: "Button", props: {} }),
    });

    expect(response.status).toBe(200);

    const result = await callbackPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.data);
      expect(parsed.component).toBe("Button");
    }
  });

  it("timeout resolves with { ok: false, reason: 'timeout' }", async () => {
    const rl = new RateLimiter();
    rateLimiters.push(rl);
    server = new CallbackServer({
      maxBodySize: 1_048_576,
      cors: CorsHandler,
      rateLimiter: rl,
      logger: mockLogger,
    });
    await server.start();

    const result = await server.waitForCallback(100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });
});
