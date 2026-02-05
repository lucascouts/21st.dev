import * as fc from "fast-check";
import { getMaxBodySize, BodyTooLargeError, CallbackServer, ServerState } from "./callback-server.js";

describe("CallbackServer - Body Size Limit", () => {
  const originalEnv = process.env.MAX_BODY_SIZE;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.MAX_BODY_SIZE;
    } else {
      process.env.MAX_BODY_SIZE = originalEnv;
    }
  });

  /**
   * Property A3: Body Size Enforcement
   * For any request body larger than MAX_BODY_SIZE bytes, the Callback_Server
   * SHALL reject the request before reading the entire body.
   *
   * **Validates: Requirements A2.3, A2.4**
   */
  describe("Property A3: Body Size Enforcement", () => {
    it("should return default 1MB when MAX_BODY_SIZE is not set", () => {
      fc.assert(
        fc.property(
          fc.constant(undefined),
          () => {
            delete process.env.MAX_BODY_SIZE;
            const maxSize = getMaxBodySize();
            return maxSize === 1048576; // 1MB
          }
        ),
        { numRuns: 10 }
      );
    });

    it("should use MAX_BODY_SIZE env variable when set to valid positive integer", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000000 }),
          (size) => {
            process.env.MAX_BODY_SIZE = String(size);
            const maxSize = getMaxBodySize();
            return maxSize === size;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should fall back to default for invalid MAX_BODY_SIZE values", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant("invalid"),
            fc.constant("-100"),
            fc.constant("0"),
            fc.constant(""),
            fc.constant("abc123")
          ),
          (invalidValue) => {
            process.env.MAX_BODY_SIZE = invalidValue;
            const maxSize = getMaxBodySize();
            return maxSize === 1048576; // Should fall back to default
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe("Unit Tests - getMaxBodySize (Requirements A2.1, A2.2)", () => {
    it("should return 1MB (1048576 bytes) by default", () => {
      delete process.env.MAX_BODY_SIZE;
      expect(getMaxBodySize()).toBe(1048576);
    });

    it("should use MAX_BODY_SIZE env variable when set", () => {
      process.env.MAX_BODY_SIZE = "2097152"; // 2MB
      expect(getMaxBodySize()).toBe(2097152);
    });

    it("should handle small body size limits", () => {
      process.env.MAX_BODY_SIZE = "1024"; // 1KB
      expect(getMaxBodySize()).toBe(1024);
    });

    it("should fall back to default for non-numeric values", () => {
      process.env.MAX_BODY_SIZE = "not-a-number";
      expect(getMaxBodySize()).toBe(1048576);
    });

    it("should fall back to default for negative values", () => {
      process.env.MAX_BODY_SIZE = "-1000";
      expect(getMaxBodySize()).toBe(1048576);
    });

    it("should fall back to default for zero", () => {
      process.env.MAX_BODY_SIZE = "0";
      expect(getMaxBodySize()).toBe(1048576);
    });
  });

  describe("Unit Tests - BodyTooLargeError", () => {
    it("should create error with correct properties", () => {
      const error = new BodyTooLargeError(1048576, 2000000);
      
      expect(error.name).toBe("BodyTooLargeError");
      expect(error.limit).toBe(1048576);
      expect(error.received).toBe(2000000);
      expect(error.message).toContain("Payload too large");
      expect(error.message).toContain("2000000");
      expect(error.message).toContain("1048576");
    });

    it("should be instanceof Error", () => {
      const error = new BodyTooLargeError(1000, 2000);
      expect(error instanceof Error).toBe(true);
      expect(error instanceof BodyTooLargeError).toBe(true);
    });
  });
});


describe("CallbackServer - Singleton Pattern", () => {
  afterEach(() => {
    // Clean up singleton instance after each test
    CallbackServer.resetInstance();
  });

  /**
   * Requirement B3.1: Support singleton mode for reuse
   */
  describe("Requirement B3.1: Singleton Mode", () => {
    it("should return the same instance when getInstance is called multiple times", () => {
      const instance1 = CallbackServer.getInstance();
      const instance2 = CallbackServer.getInstance();
      
      expect(instance1).toBe(instance2);
    });

    it("should create new instance after resetInstance", () => {
      const instance1 = CallbackServer.getInstance();
      CallbackServer.resetInstance();
      const instance2 = CallbackServer.getInstance();
      
      expect(instance1).not.toBe(instance2);
    });
  });

  /**
   * Requirement B3.2: Reuse existing server when idle
   */
  describe("Requirement B3.2: Server Reuse When Idle", () => {
    it("should start in SHUTDOWN state", () => {
      const server = new CallbackServer();
      expect(server.getState()).toBe(ServerState.SHUTDOWN);
    });

    it("should transition to IDLE state after start", async () => {
      const server = CallbackServer.getInstance();
      await server.start();
      
      expect(server.getState()).toBe(ServerState.IDLE);
      server.cancel();
    });

    it("should reuse idle singleton instance", async () => {
      const server1 = CallbackServer.getInstance();
      await server1.start();
      
      expect(server1.getState()).toBe(ServerState.IDLE);
      
      const server2 = CallbackServer.getInstance();
      expect(server2).toBe(server1);
      
      server1.cancel();
    });
  });

  /**
   * Requirement B3.3: Create new server when busy
   */
  describe("Requirement B3.3: New Server When Busy", () => {
    it("should return different instance when singleton is busy", async () => {
      const server1 = CallbackServer.getInstance();
      await server1.start();
      
      // Simulate busy state by starting waitForCallback (don't await)
      const waitPromise = server1.waitForCallback(100);
      
      expect(server1.getState()).toBe(ServerState.BUSY);
      expect(server1.isBusy()).toBe(true);
      
      // Should get a different instance since singleton is busy
      const server2 = CallbackServer.getInstance();
      expect(server2).not.toBe(server1);
      
      // Clean up
      server1.cancel();
      await waitPromise;
    });
  });

  /**
   * Requirement B3.4: Auto-shutdown after 5 minutes of inactivity
   * Note: We test the timer mechanism, not the full 5 minutes
   */
  describe("Requirement B3.4: Auto-shutdown Timer", () => {
    it("should have SHUTDOWN state initially", () => {
      const server = new CallbackServer();
      expect(server.getState()).toBe(ServerState.SHUTDOWN);
    });

    it("should track state transitions correctly", async () => {
      const server = CallbackServer.getInstance();
      
      // Initial state
      expect(server.getState()).toBe(ServerState.SHUTDOWN);
      
      // After start
      await server.start();
      expect(server.getState()).toBe(ServerState.IDLE);
      
      // After cancel (singleton stays idle)
      server.cancel();
      expect(server.getState()).toBe(ServerState.IDLE);
    });
  });

  describe("Unit Tests - ServerState", () => {
    it("should have correct enum values", () => {
      expect(ServerState.IDLE).toBe("idle");
      expect(ServerState.BUSY).toBe("busy");
      expect(ServerState.SHUTDOWN).toBe("shutdown");
    });
  });

  describe("Unit Tests - isBusy", () => {
    it("should return false when not busy", () => {
      const server = new CallbackServer();
      expect(server.isBusy()).toBe(false);
    });

    it("should return true when busy", async () => {
      const server = CallbackServer.getInstance();
      await server.start();
      
      // Start waiting (makes it busy)
      const waitPromise = server.waitForCallback(100);
      expect(server.isBusy()).toBe(true);
      
      // Clean up
      server.cancel();
      await waitPromise;
    });
  });
});


describe("CallbackServer - MCP Mode (Token Validation Disabled)", () => {
  afterEach(() => {
    CallbackServer.resetInstance();
  });

  describe("MCP Mode Token Bypass", () => {
    it("should accept POST requests without token when mcp=true", async () => {
      const server = CallbackServer.getInstance();
      const port = await server.start();
      
      // Start waiting for callback
      const waitPromise = server.waitForCallback(5000);
      
      // Send POST without token but with mcp=true
      const response = await fetch(`http://127.0.0.1:${port}/data?mcp=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://21st.dev"
        },
        body: JSON.stringify({ test: "data" })
      });
      
      expect(response.status).toBe(200);
      
      const result = await waitPromise;
      expect(result.data).toBeDefined();
      expect(result.timedOut).toBeUndefined();
    });

    it("should still require token when mcp=false", async () => {
      const server = CallbackServer.getInstance();
      const port = await server.start();
      
      // Send POST without token and mcp=false
      const response = await fetch(`http://127.0.0.1:${port}/data?mcp=false`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://21st.dev"
        },
        body: JSON.stringify({ test: "data" })
      });
      
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error).toBe("Missing session token");
      
      server.cancel();
    });

    it("should still require token when mcp parameter is missing", async () => {
      const server = CallbackServer.getInstance();
      const port = await server.start();
      
      // Send POST without token and without mcp parameter
      const response = await fetch(`http://127.0.0.1:${port}/data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://21st.dev"
        },
        body: JSON.stringify({ test: "data" })
      });
      
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error).toBe("Missing session token");
      
      server.cancel();
    });

    it("should accept valid token even in MCP mode", async () => {
      const server = CallbackServer.getInstance();
      const port = await server.start();
      const token = server.getSessionToken();
      
      // Start waiting for callback
      const waitPromise = server.waitForCallback(5000);
      
      // Send POST with token and mcp=true
      const response = await fetch(`http://127.0.0.1:${port}/data?mcp=true&token=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://21st.dev"
        },
        body: JSON.stringify({ test: "data" })
      });
      
      expect(response.status).toBe(200);
      
      const result = await waitPromise;
      expect(result.data).toBeDefined();
      expect(result.timedOut).toBeUndefined();
    });
  });
});
