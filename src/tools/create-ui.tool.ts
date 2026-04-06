import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import type { BrowserDetector } from "../browser/detector.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import { CallbackServer } from "../callback/callback-server.js";
import { CorsHandler } from "../callback/cors.js";
import { RateLimiter } from "../security/rate-limiter.js";
import { ShellSanitizer } from "../security/shell-sanitizer.js";
import { PathValidator } from "../security/path-validator.js";

const createUiSchema = z.object({
  message: z.string().describe("Full users message"),
  searchQuery: z
    .string()
    .describe(
      "Generate a search query for 21st.dev (library for searching UI components) to find a UI component that matches the user's message. Must be a two-four words max or phrase"
    ),
  absolutePathToCurrentFile: z
    .string()
    .describe("Absolute path to the current file to which we want to apply changes"),
  standaloneRequestQuery: z
    .string()
    .describe(
      "You need to formulate what component user wants to create, based on his message, possbile chat histroy and a place where he makes the request. Extract additional context about what should be done to create a ui component/page based on the user's message, search query, and conversation history, files. Don't halucinate and be on point."
    ),
});

interface CreateUiResponse {
  text: string;
}

export interface CreateUiToolDeps {
  httpClient: HttpClient;
  browserDetector: BrowserDetector;
  logger: Logger;
  config: Config;
}

export class CreateUiTool extends BaseTool<typeof createUiSchema> {
  readonly name = "magic_component_builder";
  readonly description = `
"Use this tool when the user requests a new UI component\u2014e.g., mentions /ui, /21 /21st, or asks for a button, input, dialog, table, form, banner, card, or other React component.
This tool ONLY returns the text snippet for that UI component.
After calling this tool, you must edit or add files to integrate the snippet into the codebase."
`;
  readonly schema = createUiSchema;

  private readonly httpClient: HttpClient;
  private readonly browserDetector: BrowserDetector;
  private readonly logger: Logger;
  private readonly config: Config;

  constructor(deps: CreateUiToolDeps) {
    super();
    this.httpClient = deps.httpClient;
    this.browserDetector = deps.browserDetector;
    this.logger = deps.logger;
    this.config = deps.config;
  }

  async execute(args: z.infer<typeof createUiSchema>): Promise<ToolResponse> {
    const { standaloneRequestQuery, absolutePathToCurrentFile, message, searchQuery } = args;

    this.logger.info(`Creating UI component...`);
    this.logger.debug(`Query: ${standaloneRequestQuery}`);

    // Try browser + callback first
    const browserResult = await this.tryBrowserCallback(standaloneRequestQuery);

    if (browserResult) {
      // Check if it's a URL for manual opening
      if (browserResult.startsWith("BROWSER_URL:")) {
        const url = browserResult.replace("BROWSER_URL:", "");
        this.logger.warn(`Browser could not be opened automatically`);

        // Fall back to API but include the URL in case user wants to browse
        const apiResult = await this.fallbackToApi(message, searchQuery, absolutePathToCurrentFile);

        // Prepend URL info to the response
        const urlInfo = `\n\n---\n**Browse components visually:** [Open 21st.dev Magic Chat](${url})\n---\n\n`;
        return {
          content: [{
            type: "text" as const,
            text: urlInfo + apiResult.content[0].text,
          }],
        };
      }

      this.logger.info(`Got result from browser callback`);
      return {
        content: [{ type: "text" as const, text: this.formatResponse(browserResult) }],
      };
    }

    // Fallback to direct API
    this.logger.info(`Browser callback failed/timed out, using API fallback`);
    return this.fallbackToApi(message, searchQuery, absolutePathToCurrentFile);
  }

  private async tryBrowserCallback(query: string): Promise<string | null> {
    try {
      const server = new CallbackServer({
        maxBodySize: this.config.maxBodySize,
        cors: CorsHandler,
        rateLimiter: new RateLimiter(),
        logger: this.logger,
      });
      const port = await server.start();
      this.logger.debug(`Callback server started on port ${port}`);

      const rawUrl = `https://21st.dev/magic-chat?q=${encodeURIComponent(query)}&mcp=true&port=${port}`;
      let url: string;
      try {
        url = ShellSanitizer.sanitizeUrl(rawUrl);
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this.logger.debug(`URL sanitization failed: ${errorMessage}`);
        server.cancel();
        return null;
      }

      const browserOpened = await this.browserDetector.openUrl(url);

      if (!browserOpened) {
        this.logger.warn(`Could not open browser, please open manually: ${url}`);
        server.cancel();
        return `BROWSER_URL:${url}`;
      }

      this.logger.debug(`Browser opened, waiting for callback...`);
      const result = await server.waitForCallback(120000);

      if (!result.ok) {
        this.logger.debug(`Browser callback failed: ${result.reason}`);
        return null;
      }

      return result.data;
    } catch (error) {
      this.logger.error(`Browser callback error:`, error);
      return null;
    }
  }

  private async fallbackToApi(
    message: string,
    searchQuery: string,
    absolutePathToCurrentFile: string
  ): Promise<ToolResponse> {
    try {
      let fileContent = "";
      try {
        const pathValidator = new PathValidator();
        const validation = await pathValidator.validate(absolutePathToCurrentFile, "/");
        if (validation.valid && validation.normalizedPath) {
          const file = Bun.file(validation.normalizedPath);
          const exists = await file.exists();
          if (exists) {
            fileContent = await file.text();
          }
        }
      } catch {
        // ignore
      }

      const { data, status, ok } = await this.httpClient.post<CreateUiResponse>(
        "/api/fetch-ui",
        { message, searchQuery, fileContent }
      );

      if (!ok || !data?.text) {
        throw new Error(`API returned status ${status}`);
      }

      this.logger.info(`Got result from API fallback`);
      return {
        content: [{ type: "text" as const, text: this.formatResponse(data.text) }],
      };
    } catch (error) {
      this.logger.error(`API fallback error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to create component. Please try again or check your API key.",
        this.errorCode("API_ERROR"),
        { originalError: errorMessage }
      );
    }
  }

  private formatResponse(prompt: string): string {
    return `${prompt}

## Shadcn/ui instructions
After you add the component, make sure to add the component to the project. If you can't resolve components from demo code,
Make sure to install shadcn/ui components from the demo code missing imports

Examples of importing shadcn/ui components:
if these imports can't be resolved:
\`\`\`tsx
import {
  Table
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
\`\`\`

then run this command:
\`\`\`bash
npx shadcn@latest add table textarea
\`\`\``;
  }
}
