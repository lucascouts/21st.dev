import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import { PathValidator } from "../security/path-validator.js";

const refineUiSchema = z.object({
  userMessage: z.string().describe("Full user's message about UI refinement"),
  absolutePathToRefiningFile: z
    .string()
    .describe("Absolute path to the file that needs to be refined"),
  context: z
    .string()
    .describe(
      "Extract the specific UI elements and aspects that need improvement based on user messages, code, and conversation history. Identify exactly which components (buttons, forms, modals, etc.) the user is referring to and what aspects (styling, layout, responsiveness, etc.) they want to enhance. Do not include generic improvements - focus only on what the user explicitly mentions or what can be reasonably inferred from the available context. If nothing specific is mentioned or you cannot determine what needs improvement, return an empty string."
    ),
});

interface RefineUiResponse {
  text: string;
}

export interface RefineUiToolDeps {
  httpClient: HttpClient;
  logger: Logger;
  config: Config;
}

export class RefineUiTool extends BaseTool<typeof refineUiSchema> {
  readonly name = "magic_component_refiner";
  readonly description = `
"Use this tool when the user requests to re-design/refine/improve current UI component with /ui or /21 commands,
or when context is about improving, or refining UI for a React component or molecule (NOT for big pages).
This tool improves UI of components and returns redesigned version of the component and instructions on how to implement it."
`;
  readonly schema = refineUiSchema;

  private readonly httpClient: HttpClient;
  private readonly logger: Logger;
  private readonly config: Config;

  constructor(deps: RefineUiToolDeps) {
    super();
    this.httpClient = deps.httpClient;
    this.logger = deps.logger;
    this.config = deps.config;
  }

  async execute(args: z.infer<typeof refineUiSchema>): Promise<ToolResponse> {
    const { userMessage, absolutePathToRefiningFile, context } = args;

    try {
      this.logger.info(`Refining UI component...`);
      this.logger.debug(`File: ${absolutePathToRefiningFile}`);

      // Read file content with path validation and size check
      let fileContent: string;
      const pathValidator = new PathValidator();
      const validation = await pathValidator.validate(absolutePathToRefiningFile, "/");
      if (!validation.valid || !validation.normalizedPath) {
        throw new Error(`Invalid file path: ${validation.error}`);
      }

      const file = Bun.file(validation.normalizedPath);
      const exists = await file.exists();
      if (!exists) {
        throw new Error(`File not found: ${absolutePathToRefiningFile}`);
      }

      const fileSize = file.size;
      if (fileSize > this.config.maxFileSize) {
        throw new Error(
          `File size (${fileSize} bytes) exceeds maximum allowed size (${this.config.maxFileSize} bytes)`
        );
      }

      fileContent = await file.text();

      const { data, status, ok } = await this.httpClient.post<RefineUiResponse>(
        "/api/refine-ui",
        { userMessage, fileContent, context }
      );

      if (!ok) {
        throw new Error(`API returned status ${status}`);
      }

      this.logger.info(`Successfully refined component`);

      return {
        content: [
          {
            type: "text" as const,
            text: data.text,
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error executing tool:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to refine UI component. Please try again or check your API key.",
        this.errorCode("API_ERROR"),
        { originalError: errorMessage }
      );
    }
  }
}
