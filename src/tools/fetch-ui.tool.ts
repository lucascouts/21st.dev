import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import type { Logger } from "../logger.js";

const fetchUiSchema = z.object({
  message: z.string().describe("Full users message"),
  searchQuery: z
    .string()
    .describe(
      "Search query for 21st.dev (library for searching UI components) to find a UI component that matches the user's message. Must be a two-four words max or phrase"
    ),
});

interface FetchUiResponse {
  text: string;
}

export interface FetchUiToolDeps {
  httpClient: HttpClient;
  logger: Logger;
}

export class FetchUiTool extends BaseTool<typeof fetchUiSchema> {
  readonly name = "magic_component_inspiration";
  readonly description = `
"Use this tool when the user wants to see component, get inspiration, or /21st fetch data and previews from 21st.dev. This tool returns the JSON data of matching components without generating new code. This tool ONLY returns the text snippet for that UI component.
After calling this tool, you must edit or add files to integrate the snippet into the codebase."
`;
  readonly schema = fetchUiSchema;

  private readonly httpClient: HttpClient;
  private readonly logger: Logger;

  constructor(deps: FetchUiToolDeps) {
    super();
    this.httpClient = deps.httpClient;
    this.logger = deps.logger;
  }

  async execute(args: z.infer<typeof fetchUiSchema>): Promise<ToolResponse> {
    const { message, searchQuery } = args;

    try {
      this.logger.info(`Fetching UI inspiration...`);
      this.logger.debug(`Search: ${searchQuery}`);

      const { data, status, ok } = await this.httpClient.post<FetchUiResponse>(
        "/api/fetch-ui",
        { message, searchQuery }
      );

      if (!ok) {
        throw new Error(`API returned status ${status}`);
      }

      this.logger.info(`Successfully fetched inspiration`);

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
        "Failed to fetch UI inspiration. Please try again or check your API key.",
        this.errorCode("API_ERROR"),
        { originalError: errorMessage }
      );
    }
  }
}
