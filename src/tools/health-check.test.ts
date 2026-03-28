import { describe, it, expect, beforeEach } from "vitest";
import { HealthCheckTool } from "./health-check.js";

describe("HealthCheckTool", () => {
  let tool: HealthCheckTool;

  beforeEach(() => {
    tool = new HealthCheckTool();
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
    expect(healthStatus.checks).toHaveProperty("uptime_seconds");
  });

  it("should report uptime in seconds", async () => {
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
  });

  it("should report status as healthy, degraded, or unhealthy", async () => {
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(["healthy", "degraded", "unhealthy"]).toContain(healthStatus.status);
  });

  it("should handle API connectivity check gracefully", async () => {
    const result = await tool.execute({});
    const healthStatus = JSON.parse(result.content[0].text);
    
    expect(typeof healthStatus.checks.api_reachable).toBe("boolean");
  });
});
