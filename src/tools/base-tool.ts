import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export abstract class BaseTool<TSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly schema: TSchema;

  abstract execute(args: z.infer<TSchema>): Promise<ToolResponse>;

  register(server: McpServer): void {
    server.tool(this.name, this.description, this.schema.shape as any, this.execute.bind(this) as any);
  }

  protected formatError(message: string, code: string, details?: Record<string, unknown>): ToolResponse {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message, code, ...(details && { details }) }, null, 2) }],
      isError: true,
    };
  }

  protected errorCode(errorType: string): string {
    return `${this.name.replace(/^magic_/, "").toUpperCase().replace(/-/g, "_")}_${errorType}`;
  }
}
