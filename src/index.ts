#!/usr/bin/env bun

import { parseConfig } from "./config.js";
import { Logger } from "./logger.js";
import { HttpClient } from "./http/client.js";
import { BrowserDetector } from "./browser/detector.js";
import { MagicServer } from "./server.js";

// 1. Parse and freeze config — throws if invalid
const config = parseConfig();

// 2. Create logger (stderr only — stdout is reserved for MCP JSON-RPC)
const logger = new Logger(config.logLevel);

// 3. Create HTTP client with retry config
const httpClient = new HttpClient({
  baseUrl: config.debug ? "http://localhost:3005" : "https://magic.21st.dev",
  apiKey: config.apiKey,
  timeout: config.timeout,
  retry: {
    maxRetries: 3,
    baseDelay: 1_000,
    maxDelay: 8_000,
    jitterMax: 500,
  },
  logger,
});

// 4. Create browser detector
const browserDetector = new BrowserDetector(logger);

// 5. Create and start server
const server = new MagicServer({ config, httpClient, browserDetector, logger });

server.start().catch((error) => {
  logger.error("Fatal error starting server:", error);
  process.exitCode = 1;
});

// 6. Signal handlers
process.on("SIGTERM", () => {
  logger.info("Received SIGTERM");
  server.shutdown();
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT");
  server.shutdown();
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});
