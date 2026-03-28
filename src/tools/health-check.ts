import { z } from "zod";
import { BaseTool, ToolResponse } from "../utils/base-tool.js";
import { BASE_URL } from "../utils/http-client.js";

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    api_reachable: boolean;
    api_latency_ms?: number;
    uptime_seconds: number;
  };
  timestamp: string;
}

/**
 * Health Check Tool
 * Requirements: C3.1, C3.2, C3.3, C3.4
 */
export class HealthCheckTool extends BaseTool {
  name = "magic_health_check";
  description = "Check the health status of the Magic MCP server, including API connectivity, cache statistics, and uptime";
  schema = z.object({});

  private startTime = Date.now();

  async execute(): Promise<ToolResponse> {
    try {
      const healthStatus = await this.checkHealth();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(healthStatus, null, 2),
          },
        ],
      };
    } catch (error) {
      return this.formatError(
        error instanceof Error ? error.message : "Unknown error during health check",
        this.generateErrorCode("HEALTH_CHECK_FAILED"),
        { error: String(error) }
      );
    }
  }

  /**
   * Perform health check
   * Requirements: C3.1, C3.2, C3.3, C3.4
   */
  private async checkHealth(): Promise<HealthStatus> {
    const apiCheck = await this.checkApiConnectivity();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    
    return {
      status: apiCheck.reachable ? "healthy" : "unhealthy",
      checks: {
        api_reachable: apiCheck.reachable,
        ...(apiCheck.latency !== undefined && { api_latency_ms: apiCheck.latency }),
        uptime_seconds: uptimeSeconds,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check API connectivity to 21st.dev
   * Requirements: C3.2
   */
  private async checkApiConnectivity(): Promise<{ reachable: boolean; latency?: number }> {
    try {
      const startTime = Date.now();
      
      // Make a lightweight request to check connectivity
      // Using a HEAD-like approach by making a minimal GET request
      const response = await fetch(`${BASE_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout for health check
      });
      
      const latency = Date.now() - startTime;
      
      return {
        reachable: response.ok || response.status < 500,
        latency,
      };
    } catch (error) {
      // API is not reachable
      return {
        reachable: false,
      };
    }
  }
}
