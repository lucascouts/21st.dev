import { z } from "zod";
import { BaseTool } from "../utils/base-tool.js";
import { twentyFirstClient } from "../utils/http-client.js";
import { CallbackServer } from "../utils/callback-server.js";
import { getContentOfFile } from "../utils/get-content-of-file.js";
import { ShellSanitizer } from "../utils/shell-sanitizer.js";
import { Logger } from "../utils/logger.js";
import {
  BrowserDetector,
  resetDisplayEnvCache,
  resetBrowserCache,
} from "../utils/browser-detector.js";

const logger = new Logger("CreateUI");
const UI_TOOL_NAME = "magic_component_builder";
const UI_TOOL_DESCRIPTION = `
"Use this tool when the user requests a new UI component—e.g., mentions /ui, /21 /21st, or asks for a button, input, dialog, table, form, banner, card, or other React component.
This tool ONLY returns the text snippet for that UI component. 
After calling this tool, you must edit or add files to integrate the snippet into the codebase."
`;

// Re-export for backward compatibility (Requirement C1.4)
export { resetDisplayEnvCache, resetBrowserCache };

interface CreateUiResponse {
  text: string;
}

export class CreateUiTool extends BaseTool {
  name = UI_TOOL_NAME;
  description = UI_TOOL_DESCRIPTION;

  schema = z.object({
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

  async execute({
    standaloneRequestQuery,
    absolutePathToCurrentFile,
    message,
    searchQuery,
  }: z.infer<typeof this.schema>): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    logger.info(`Creating UI component...`);
    logger.debug(`Query: ${standaloneRequestQuery}`);

    // Try browser + callback first
    const browserResult = await this.tryBrowserCallback(standaloneRequestQuery);
    
    if (browserResult) {
      // Check if it's a URL for manual opening
      if (browserResult.startsWith("BROWSER_URL:")) {
        const url = browserResult.replace("BROWSER_URL:", "");
        logger.warn(`Browser could not be opened automatically`);
        
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
      
      logger.info(`Got result from browser callback`);
      return {
        content: [{ type: "text" as const, text: this.formatResponse(browserResult) }],
      };
    }

    // Fallback to direct API
    logger.info(`Browser callback failed/timed out, using API fallback`);
    return this.fallbackToApi(message, searchQuery, absolutePathToCurrentFile);
  }

  private async tryBrowserCallback(query: string): Promise<string | null> {
    try {
      const server = CallbackServer.getInstance();
      const port = await server.start();
      logger.debug(`Callback server started on port ${port}`);
      
      const sessionToken = server.getSessionToken();
      if (!sessionToken) {
        logger.debug(`Failed to get session token`);
        server.cancel();
        return null;
      }

      const rawUrl = `https://21st.dev/magic-chat?q=${encodeURIComponent(query)}&mcp=true&port=${port}`;
      let url: string;
      try {
        url = ShellSanitizer.sanitizeUrl(rawUrl);
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.debug(`URL sanitization failed: ${errorMessage}`);
        server.cancel();
        return null;
      }

      // Use BrowserDetector.openUrl() to open browser (Recommendation #1)
      const browserOpened = await BrowserDetector.openUrl(url);

      if (!browserOpened) {
        logger.warn(`Could not open browser, please open manually: ${url}`);
        server.cancel();
        return `BROWSER_URL:${url}`;
      }

      logger.debug(`Browser opened, waiting for callback...`);
      const result = await server.waitForCallback(120000);

      if (result.timedOut || !result.data) {
        logger.debug(`Browser callback timed out or no data`);
        return null;
      }

      return result.data;
    } catch (error) {
      logger.error(`Browser callback error:`, error);
      return null;
    }
  }

  private async fallbackToApi(
    message: string,
    searchQuery: string,
    absolutePathToCurrentFile: string
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      let fileContent = "";
      try {
        fileContent = await getContentOfFile(absolutePathToCurrentFile);
      } catch {
        // ignore
      }

      const { data, status } = await twentyFirstClient.post<CreateUiResponse>(
        "/api/fetch-ui", // Same endpoint as fetch-ui tool — by design of 21st.dev API
        { message, searchQuery, fileContent }
      );

      if (status !== 200 || !data?.text) {
        throw new Error(`API returned status ${status}`);
      }

      logger.info(`Got result from API fallback`);
      return {
        content: [{ type: "text" as const, text: this.formatResponse(data.text) }],
      };
    } catch (error) {
      logger.error(`API fallback error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to create component. Please try again or check your API key.",
        this.generateErrorCode("API_ERROR"),
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
