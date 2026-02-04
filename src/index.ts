#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { setupJsonConsole } from "./utils/console.js";
import { Logger } from "./utils/logger.js";

import { CreateUiTool } from "./tools/create-ui.js";
import { FetchUiTool } from "./tools/fetch-ui.js";
import { LogoSearchTool } from "./tools/logo-search.js";
import { RefineUiTool } from "./tools/refine-ui.js";

setupJsonConsole();

const logger = new Logger("Server");

const VERSION = "1.0.0";
const server = new McpServer({
  name: "magic-mcp",
  version: VERSION,
});

// Register tools with Gemini-compatible names (no leading digits)
new CreateUiTool().register(server);
new LogoSearchTool().register(server);
new FetchUiTool().register(server);
new RefineUiTool().register(server);

async function runServer() {
  const transport = new StdioServerTransport();
  logger.info(`Starting magic-mcp server v${VERSION} (PID: ${process.pid})`);

  let isShuttingDown = false;

  const cleanup = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Shutting down server (PID: ${process.pid})...`);
    try {
      transport.close();
    } catch (error) {
      logger.error(`Error closing transport (PID: ${process.pid}):`, error);
    }
    logger.info(`Server closed (PID: ${process.pid})`);
    process.exit(0);
  };

  transport.onerror = (error: Error) => {
    logger.error(`Transport error (PID: ${process.pid}):`, error);
    cleanup();
  };

  transport.onclose = () => {
    logger.warn(`Transport closed unexpectedly (PID: ${process.pid})`);
    cleanup();
  };

  process.on("SIGTERM", () => {
    logger.info(`Received SIGTERM (PID: ${process.pid})`);
    cleanup();
  });

  process.on("SIGINT", () => {
    logger.info(`Received SIGINT (PID: ${process.pid})`);
    cleanup();
  });

  process.on("beforeExit", () => {
    logger.debug(`Received beforeExit (PID: ${process.pid})`);
    cleanup();
  });

  await server.connect(transport);
  logger.info(`Server started (PID: ${process.pid})`);
}

runServer().catch((error) => {
  logger.error(`Fatal error running server (PID: ${process.pid}):`, error);
  if (!process.exitCode) {
    process.exit(1);
  }
});
