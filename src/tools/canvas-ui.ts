import { z } from "zod";
import { BaseTool } from "../utils/base-tool.js";
import { CallbackServer } from "../utils/callback-server.js";
import { Logger } from "../utils/logger.js";
import { BrowserDetector } from "../utils/browser-detector.js";

const logger = new Logger("CanvasUI");
const CANVAS_TOOL_NAME = "magic_component_canvas";
const CANVAS_TOOL_DESCRIPTION = `
"Use this tool when the user wants to visually build or design a UI component using the 21st.dev Canvas editor.
Unlike magic_component_builder which returns code directly, this tool opens an interactive visual canvas
where the user can design components with drag-and-drop and visual editing.
Use when the user mentions /canvas, visual editor, or wants to design components interactively."
`;

export class CanvasUiTool extends BaseTool {
  name = CANVAS_TOOL_NAME;
  description = CANVAS_TOOL_DESCRIPTION;

  schema = z.object({
    message: z.string().describe("Full users message"),
    standaloneRequestQuery: z
      .string()
      .describe(
        "Formulate what component the user wants to create based on their message and context. Be specific and on point."
      ),
  });

  async execute({
    message,
    standaloneRequestQuery,
  }: z.infer<typeof this.schema>): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    logger.info(`Opening canvas editor...`);

    try {
      const server = CallbackServer.getInstance();
      const port = await server.start();

      const sessionToken = server.getSessionToken();
      if (!sessionToken) {
        server.cancel();
        return this.formatError(
          "Failed to generate session token for canvas.",
          this.generateErrorCode("TOKEN_ERROR")
        );
      }

      const params = new URLSearchParams({
        q: `Primary request: ${message}\n\nAdditional context: ${standaloneRequestQuery}`,
        mcp: "true",
        port: port.toString(),
      });

      const url = `https://21st.dev/canvas/new?${params.toString()}`;

      const browserOpened = await BrowserDetector.openUrl(url);

      if (!browserOpened) {
        server.cancel();
        return {
          content: [{
            type: "text" as const,
            text: `Could not open browser automatically.\n\n**Open the canvas manually:** [21st.dev Canvas](${url})`,
          }],
        };
      }

      logger.info(`Canvas opened, waiting for callback...`);
      const result = await server.waitForCallback(300000); // 5 min timeout for canvas

      if (result.timedOut || !result.data) {
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
      logger.error(`Canvas error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to open canvas. Please try again.",
        this.generateErrorCode("CANVAS_ERROR"),
        { originalError: errorMessage }
      );
    }
  }
}
