import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import type { Logger } from "../logger.js";

const healthCheckSchema = z.object({});

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    api_reachable: boolean;
    api_latency_ms?: number;
    uptime_seconds: number;
  };
  timestamp: string;
}

export interface HealthCheckToolDeps {
  httpClient: HttpClient;
  logger: Logger;
}

export class HealthCheckTool extends BaseTool<typeof healthCheckSchema> {
  readonly name = "magic_health_check";
  readonly description = "Check the health status of the Magic MCP server, including API connectivity, cache statistics, and uptime";
  readonly schema = healthCheckSchema;

  private readonly httpClient: HttpClient;
  private readonly logger: Logger;
  private readonly startTime = Date.now();

  constructor(deps: HealthCheckToolDeps) {
    super();
    this.httpClient = deps.httpClient;
    this.logger = deps.logger;
  }

  async execute(_args: z.infer<typeof healthCheckSchema>): Promise<ToolResponse> {
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
        this.errorCode("HEALTH_CHECK_FAILED"),
        { error: String(error) }
      );
    }
  }

  private async checkHealth(): Promise<HealthStatus> {
    const apiCheck = await this.checkApiConnectivity();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    let status: HealthStatus["status"];
    if (!apiCheck.reachable) {
      status = "unhealthy";
    } else if (apiCheck.latency !== undefined && apiCheck.latency > 2000) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    return {
      status,
      checks: {
        api_reachable: apiCheck.reachable,
        ...(apiCheck.latency !== undefined && { api_latency_ms: apiCheck.latency }),
        uptime_seconds: uptimeSeconds,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkApiConnectivity(): Promise<{ reachable: boolean; latency?: number }> {
    try {
      const startTime = Date.now();

      const { ok, status } = await this.httpClient.get<unknown>("/health");

      const latency = Date.now() - startTime;

      return {
        reachable: ok || (status > 0 && status < 500),
        latency,
      };
    } catch {
      return {
        reachable: false,
      };
    }
  }
}
