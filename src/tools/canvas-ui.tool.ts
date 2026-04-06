import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { BrowserDetector } from "../browser/detector.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import { CallbackServer } from "../callback/callback-server.js";
import { CorsHandler } from "../callback/cors.js";
import { RateLimiter } from "../security/rate-limiter.js";

const canvasUiSchema = z.object({
  message: z.string().describe("Full users message"),
  standaloneRequestQuery: z
    .string()
    .describe(
      "Formulate what component the user wants to create based on their message and context. Be specific and on point."
    ),
});

export interface CanvasUiToolDeps {
  browserDetector: BrowserDetector;
  logger: Logger;
  config: Config;
}

export class CanvasUiTool extends BaseTool<typeof canvasUiSchema> {
  readonly name = "magic_component_canvas";
  readonly description = `
"Use this tool when the user wants to visually build or design a UI component using the 21st.dev Canvas editor.
Unlike magic_component_builder which returns code directly, this tool opens an interactive visual canvas
where the user can design components with drag-and-drop and visual editing.
Use when the user mentions /canvas, visual editor, or wants to design components interactively."
`;
  readonly schema = canvasUiSchema;

  private readonly browserDetector: BrowserDetector;
  private readonly logger: Logger;
  private readonly config: Config;

  constructor(deps: CanvasUiToolDeps) {
    super();
    this.browserDetector = deps.browserDetector;
    this.logger = deps.logger;
    this.config = deps.config;
  }

  async execute(args: z.infer<typeof canvasUiSchema>): Promise<ToolResponse> {
    const { message, standaloneRequestQuery } = args;

    this.logger.info(`Opening canvas editor...`);

    try {
      const server = new CallbackServer({
        maxBodySize: this.config.maxBodySize,
        cors: CorsHandler,
        rateLimiter: new RateLimiter(),
        logger: this.logger,
      });
      const port = await server.start();

      const params = new URLSearchParams({
        q: `Primary request: ${message}\n\nAdditional context: ${standaloneRequestQuery}`,
        mcp: "true",
        port: port.toString(),
      });

      const url = `https://21st.dev/canvas/new?${params.toString()}`;

      const browserOpened = await this.browserDetector.openUrl(url);

      if (!browserOpened) {
        server.cancel();
        return {
          content: [{
            type: "text" as const,
            text: `Could not open browser automatically.\n\n**Open the canvas manually:** [21st.dev Canvas](${url})`,
          }],
        };
      }

      this.logger.info(`Canvas opened, waiting for callback...`);
      const result = await server.waitForCallback(300000); // 5 min timeout for canvas

      if (!result.ok) {
        return {
          content: [{
            type: "text" as const,
            text: "Canvas session timed out. The user may still be designing. If they completed the design, ask them to try again.",
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: result.data }],
      };
    } catch (error) {
      this.logger.error(`Canvas error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to open canvas. Please try again.",
        this.errorCode("CANVAS_ERROR"),
        { originalError: errorMessage }
      );
    }
  }
}
