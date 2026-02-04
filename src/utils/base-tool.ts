import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ToolError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
}

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract schema: z.ZodObject<any>;

  register(server: McpServer) {
    server.tool(
      this.name,
      this.description,
      this.schema.shape,
      this.execute.bind(this)
    );
  }

  abstract execute(args: z.infer<typeof this.schema>): Promise<ToolResponse>;

  /**
   * Format error in standardized structure
   * @param message - Human-readable error message
   * @param code - Error code in TOOL_ERROR_TYPE format
   * @param details - Optional additional error details
   * @returns Formatted tool response with error
   */
  protected formatError(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ): ToolResponse {
    const errorObj: ToolError = {
      error: message,
      code,
      ...(details && { details }),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorObj, null, 2),
        },
      ],
    };
  }

  /**
   * Generate error code from tool name and error type
   * @param errorType - Type of error (e.g., "API_TIMEOUT", "INVALID_INPUT")
   * @returns Error code in format TOOL_NAME_ERROR_TYPE
   */
  protected generateErrorCode(errorType: string): string {
    const toolPrefix = this.name
      .replace(/^magic_/, "")
      .toUpperCase()
      .replace(/-/g, "_");
    return `${toolPrefix}_${errorType}`;
  }
}
