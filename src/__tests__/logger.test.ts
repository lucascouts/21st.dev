import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Logger } from "../logger.js";

describe("Logger", () => {
  let originalWrite: typeof process.stderr.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it("accepts level and optional prefix in constructor", () => {
    const logger = new Logger("debug", "TestPrefix");
    logger.debug("hello");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("[TestPrefix]");
    expect(captured[0]).toContain("[DEBUG]");
  });

  it("filters debug messages when level is info", () => {
    const logger = new Logger("info");
    logger.debug("should not appear");
    expect(captured.length).toBe(0);
  });

  it("allows info messages when level is info", () => {
    const logger = new Logger("info");
    logger.info("should appear");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("should appear");
  });

  it("outputs to process.stderr", () => {
    const logger = new Logger("debug");
    logger.info("stderr test");
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toContain("stderr test");
  });

  it("redacts secrets in output", () => {
    const logger = new Logger("debug");
    logger.info("Authorization: Bearer token1234567890abcdef1234");
    expect(captured.length).toBe(1);
    expect(captured[0]).not.toContain("token1234567890abcdef1234");
    expect(captured[0]).toContain("[REDACTED]");
  });

  it("returns the configured level via getLevel()", () => {
    const logger = new Logger("warn");
    expect(logger.getLevel()).toBe("warn");
  });
});
