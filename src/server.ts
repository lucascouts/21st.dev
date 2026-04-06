import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.js";
import type { HttpClient } from "./http/client.js";
import type { BrowserDetector } from "./browser/detector.js";
import type { Logger } from "./logger.js";

import { CreateUiTool } from "./tools/create-ui.tool.js";
import { FetchUiTool } from "./tools/fetch-ui.tool.js";
import { RefineUiTool } from "./tools/refine-ui.tool.js";
import { LogoSearchTool } from "./tools/logo-search.tool.js";
import { HealthCheckTool } from "./tools/health-check.tool.js";
import { CanvasUiTool } from "./tools/canvas-ui.tool.js";

const VERSION = "2.0.0";

export interface MagicServerConfig {
  config: Config;
  httpClient: HttpClient;
  browserDetector: BrowserDetector;
  logger: Logger;
}

export class MagicServer {
  private readonly config: Config;
  private readonly httpClient: HttpClient;
  private readonly browserDetector: BrowserDetector;
  private readonly logger: Logger;
  private transport: StdioServerTransport | null = null;
  private isShuttingDown = false;

  constructor(deps: MagicServerConfig) {
    this.config = deps.config;
    this.httpClient = deps.httpClient;
    this.browserDetector = deps.browserDetector;
    this.logger = deps.logger;
  }

  async start(): Promise<void> {
    const server = new McpServer({
      name: "magic-mcp",
      version: VERSION,
    });

    // Create and register tools with injected dependencies
    const tools = [
      new CreateUiTool({
        httpClient: this.httpClient,
        browserDetector: this.browserDetector,
        logger: this.logger,
        config: this.config,
      }),
      new FetchUiTool({
        httpClient: this.httpClient,
        logger: this.logger,
      }),
      new RefineUiTool({
        httpClient: this.httpClient,
        logger: this.logger,
        config: this.config,
      }),
      new LogoSearchTool({ logger: this.logger }),
      new HealthCheckTool({
        httpClient: this.httpClient,
        logger: this.logger,
      }),
      new CanvasUiTool({
        browserDetector: this.browserDetector,
        logger: this.logger,
        config: this.config,
      }),
    ];

    for (const tool of tools) {
      tool.register(server);
    }

    this.transport = new StdioServerTransport();
    await server.connect(this.transport);

    this.logger.info(`MagicServer v${VERSION} started (PID: ${process.pid})`);
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info("Shutting down MagicServer...");

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        this.logger.error("Error closing transport:", error);
      }
      this.transport = null;
    }

    process.exitCode = 0;
  }
}
