import { describe, it, expect, afterEach } from "bun:test";
import { HttpClient } from "../../http/client.js";

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => "debug" as const,
};

function createClient(baseUrl: string, apiKey = "test-key") {
  return new HttpClient({
    baseUrl,
    apiKey,
    timeout: 5000,
    retry: { maxRetries: 0, baseDelay: 100, maxDelay: 1000, jitterMax: 50 },
    logger: mockLogger as any,
  });
}

describe("HttpClient", () => {
  let servers: Array<ReturnType<typeof Bun.serve>> = [];

  afterEach(() => {
    for (const server of servers) {
      server.stop();
    }
    servers = [];
  });

  it("has get, post, put, delete, patch methods", () => {
    const client = createClient("http://localhost:9999");
    expect(typeof client.get).toBe("function");
    expect(typeof client.post).toBe("function");
    expect(typeof client.put).toBe("function");
    expect(typeof client.delete).toBe("function");
    expect(typeof client.patch).toBe("function");
  });

  it("includes Authorization header in requests", async () => {
    let receivedAuth = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        receivedAuth = req.headers.get("authorization") ?? "";
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    const client = createClient(`http://127.0.0.1:${server.port}`, "my-secret-key");
    await client.get("/test");

    expect(receivedAuth).toBe("Bearer my-secret-key");
  });

  it("returns ok: false for 4xx without retrying", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requestCount++;
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    const client = new HttpClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: "test",
      timeout: 5000,
      retry: { maxRetries: 3, baseDelay: 10, maxDelay: 100, jitterMax: 5 },
      logger: mockLogger as any,
    });

    const result = await client.get("/missing");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(requestCount).toBe(1);
  });
});
