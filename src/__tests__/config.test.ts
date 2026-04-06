import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseConfig } from "../config.js";

describe("parseConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses successfully with TWENTY_FIRST_API_KEY env var", () => {
    process.env.TWENTY_FIRST_API_KEY = "test-api-key-123";
    const config = parseConfig();
    expect(config.apiKey).toBe("test-api-key-123");
  });

  it("throws Zod error when apiKey is missing", () => {
    delete process.env.TWENTY_FIRST_API_KEY;
    delete process.env.API_KEY;
    expect(() => parseConfig()).toThrow();
  });

  it("returns a frozen config object", () => {
    process.env.TWENTY_FIRST_API_KEY = "test-api-key-123";
    const config = parseConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      "use strict";
      (config as any).apiKey = "changed";
    }).toThrow();
  });

  it("has correct default values", () => {
    process.env.TWENTY_FIRST_API_KEY = "test-api-key-123";
    const config = parseConfig();
    expect(config.logLevel).toBe("info");
    expect(config.timeout).toBe(30_000);
    expect(config.maxFileSize).toBe(1_048_576);
    expect(config.maxBodySize).toBe(1_048_576);
    expect(config.debug).toBe(false);
    expect(config.canvas).toBe(false);
    expect(config.github).toBe(false);
  });
});
