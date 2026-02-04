import { describe, it, expect, beforeEach, vi } from "vitest";
import { HealthCheckTool } from "./health-check.js";
import { apiCache } from "../utils/api-cache.js";

describe("HealthCheckTool", () => {
  let tool: HealthCheckTool;

  beforeEach(() => {
    tool = new HealthCheckTool();
    apiCache.clear();
    vi.clearAllMocks();
  });

  it("should have correct name and description", () => {
    expect(tool.name).toBe("magic_health_check");
    expect(tool.description).toContain("health status");
  });

  it("should return health status with all required fields", async () => {
    const result = await tool.execute({});
    
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(healthStatus).toHaveProperty("status");
    expect(healthStatus).toHaveProperty("checks");
    expect(healthStatus).toHaveProperty("timestamp");
    
    expect(healthStatus.checks).toHaveProperty("api_reachable");
    expect(healthStatus.checks).toHaveProperty("cache_entries");
    expect(healthStatus.checks).toHaveProperty("cache_hit_rate");
    expect(healthStatus.checks).toHaveProperty("uptime_seconds");
  });

  it("should report cache statistics correctly", async () => {
    // Add some cache entries
    apiCache.set("key1", { data: "value1" });
    apiCache.set("key2", { data: "value2" });
    
    // Simulate cache hits and misses
    apiCache.get("key1"); // hit
    apiCache.get("key3"); // miss
    
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(healthStatus.checks.cache_entries).toBe(2);
    expect(healthStatus.checks.cache_hit_rate).toBeGreaterThan(0);
  });

  it("should report uptime in seconds", async () => {
    // Wait a bit to ensure uptime > 0
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(healthStatus.checks.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof healthStatus.checks.uptime_seconds).toBe("number");
  });

  it("should include timestamp in ISO format", async () => {
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(healthStatus.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(healthStatus.timestamp)).not.toThrow();
  });

  it("should report status as healthy, degraded, or unhealthy", async () => {
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(["healthy", "degraded", "unhealthy"]).toContain(healthStatus.status);
  });

  it("should calculate cache hit rate correctly with no cache activity", async () => {
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(healthStatus.checks.cache_hit_rate).toBe(0);
  });

  it("should handle API connectivity check gracefully", async () => {
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(typeof healthStatus.checks.api_reachable).toBe("boolean");
  });
});
