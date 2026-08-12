import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import { textResponseSchema } from "../http/api-response.js";
import { FAILURE_MESSAGES, failureLogDetail } from "../http/failure.js";
import type { Logger } from "../logger.js";

const fetchUiSchema = z.object({
  message: z.string().describe("Full users message"),
  searchQuery: z
    .string()
    .describe(
      "Search query for 21st.dev (library for searching UI components) to find a UI component that matches the user's message. Must be a two-four words max or phrase"
    ),
});

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

      const result = await this.httpClient.post(
        "/api/fetch-ui",
        { message, searchQuery },
        textResponseSchema
      );

      if (!result.ok) {
        // Two audiences, per failure.ts. The log gets which call ended and its
        // remote-chosen status; the client gets the constant for the kind, plus
        // the kind itself — a name from a closed set an agent can branch on
        // (R2.1). Nothing remote is interpolated into either (R2.2).
        this.logger.error(
          failureLogDetail(result.kind, `POST /api/fetch-ui (status ${result.status})`)
        );
        return this.formatError(FAILURE_MESSAGES[result.kind], this.errorCode("API_ERROR"), {
          kind: result.kind,
        });
      }

      this.logger.info(`Successfully fetched inspiration`);

      return {
        content: [
          {
            type: "text" as const,
            text: result.data.text,
          },
        ],
      };
    } catch (error) {
      // Unreachable by `HttpClient`'s contract: it RETURNS its failures rather
      // than throwing them. Kept so a local fault is still REPORTED — an error
      // escaping `execute` reaches the agent as a JSON-RPC error with no
      // `isError` and no tool content, the same class of defect as the -32602
      // this sub-task closes, arriving by a different door. The engine string
      // is logged and never returned: `FailureKind` names REMOTE-call failures,
      // and none of them is "our own defect".
      this.logger.error(`magic_component_inspiration failed unexpectedly:`, error);
      return this.formatError(
        "the tool failed unexpectedly; the server log has the detail",
        this.errorCode("UNEXPECTED_ERROR")
      );
    }
  }
}
