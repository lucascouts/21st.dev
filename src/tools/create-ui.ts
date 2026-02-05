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

/**
 * Get display environment cache state (for testing)
 * @deprecated Use BrowserDetector.getCacheState() instead
 */
export function getDisplayEnvCacheState(): { env: Record<string, string>; detectedAt: number } | null {
  const cache = BrowserDetector.getCacheState();
  if (!cache?.displayEnv) return null;
  return { env: cache.displayEnv as Record<string, string>, detectedAt: cache.detectedAt };
}

/**
 * Get browser cache state (for testing)
 * @deprecated Use BrowserDetector.getCacheState() instead
 */
export function getBrowserCacheState(): { browser: string | null; detectedAt: number } | null {
  const cache = BrowserDetector.getCacheState();
  if (!cache) return null;
  return { browser: cache.defaultBrowser, detectedAt: cache.detectedAt };
}

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
    absolutePathToProjectDirectory: z
      .string()
      .describe("Absolute path to the project root directory"),
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
    const fs = await import("fs");
    const { execSync, spawn } = await import("child_process");
    const logFile = "/tmp/magic-mcp-debug.log";
    const log = (msg: string) => {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      fs.appendFileSync(logFile, line);
      logger.debug(msg);
    };

    try {
      log(`Starting tryBrowserCallback`);
      
      // Auto-detect display environment using BrowserDetector (Requirement C1.4)
      const displayEnv = await BrowserDetector.getDisplayEnv();
      log(`Detected display env: DISPLAY=${displayEnv.DISPLAY}, WAYLAND_DISPLAY=${displayEnv.WAYLAND_DISPLAY}, XDG_SESSION_TYPE=${displayEnv.XDG_SESSION_TYPE}`);
      
      // Detect default browser using BrowserDetector (Requirement C1.4)
      const defaultBrowser = await BrowserDetector.getDefaultBrowser();
      log(`Default browser detected: ${defaultBrowser || 'unknown'}`);
      
      const server = new CallbackServer();
      const port = await server.start();
      log(`Callback server started on port ${port}`);
      
      // Requirement A1.2: Get session token to include in callback URL
      const sessionToken = server.getSessionToken();
      if (!sessionToken) {
        log(`Failed to get session token`);
        server.cancel();
        return null;
      }
      log(`Session token generated for callback`);

      // Build URL with query parameter (original format)
      // Requirement A1.2: Include token as query parameter
      const rawUrl = `http://21st.dev/magic-chat?q=${encodeURIComponent(query)}&mcp=true&port=${port}&token=${sessionToken}`;
      let url: string;
      try {
        url = ShellSanitizer.sanitizeUrl(rawUrl);
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        log(`URL sanitization failed: ${errorMessage}`);
        server.cancel();
        return null;
      }
      log(`Opening browser: ${url}`);

      // Build environment with mcp.json vars taking priority, then detected, then defaults
      const browserEnv = {
        ...process.env,
        ...displayEnv,
        DISPLAY: process.env.DISPLAY || displayEnv.DISPLAY || ":0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || displayEnv.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || displayEnv.DBUS_SESSION_BUS_ADDRESS,
      };

      let browserOpened = false;
      
      // Method 1: Use systemd-run (works best in Linux desktop sessions)
      if (defaultBrowser) {
        try {
          log(`Default browser: ${defaultBrowser}, using systemd-run...`);
          
          // Map browser desktop file names to possible executable names (in order of preference)
          const browserMap: Record<string, string[]> = {
            "firefox": ["firefox", "firefox-esr"],
            "chrome": ["google-chrome-stable", "google-chrome", "chrome"],
            "brave": ["brave-browser-stable", "brave-browser", "brave"],
            "chromium": ["chromium", "chromium-browser"],
            "vivaldi": ["vivaldi-stable", "vivaldi"],
            "opera": ["opera-stable", "opera"],
            "edge": ["microsoft-edge-stable", "microsoft-edge", "msedge"],
            "zen": ["zen-browser", "zen"],
            "librewolf": ["librewolf"],
            "waterfox": ["waterfox"],
            "thorium": ["thorium-browser", "thorium"],
          };
          
          // Find matching browser executables
          let browserCandidates: string[] = [];
          for (const [key, executables] of Object.entries(browserMap)) {
            if (defaultBrowser.includes(key)) {
              browserCandidates = executables;
              break;
            }
          }
          
          if (browserCandidates.length === 0) {
            browserCandidates = ["xdg-open"];
          }
          
          // Find the first executable that exists
          let browserCmd = "";
          let browserArgs: string[] = [];
          for (const candidate of browserCandidates) {
            try {
              execSync(`which ${candidate}`, { encoding: "utf-8", timeout: 1000 });
              browserCmd = candidate;
              // Add --new-tab for Firefox-based browsers
              if (["firefox", "librewolf", "waterfox", "zen"].some(b => candidate.includes(b))) {
                browserArgs = ["--new-tab"];
              }
              log(`Found executable: ${browserCmd}`);
              break;
            } catch {
              // Executable not found, try next
            }
          }
          
          if (!browserCmd) {
            browserCmd = "xdg-open";
            log(`No executable found, falling back to xdg-open`);
          }
          
          // Use array-based spawn arguments for security (Requirement 7.4)
          const systemdArgs = ["--user", "--no-block", "--collect", browserCmd, ...browserArgs, url];
          log(`Browser command: systemd-run ${systemdArgs.join(" ")}`);
          
          const child = spawn("systemd-run", systemdArgs, { 
            env: browserEnv, 
            stdio: "ignore",
            timeout: 5000 
          });
          
          // Wait briefly for spawn to complete
          await new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.on("spawn", () => {
              log(`Launched ${browserCmd} via systemd-run`);
              resolve();
            });
            // Timeout fallback
            setTimeout(resolve, 1000);
          });
          
          browserOpened = true;
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          log(`systemd-run failed: ${errorMessage}`);
        }
      }
      
      // Method 2: Try spawn with xdg-open
      if (!browserOpened) {
        try {
          log(`Attempting xdg-open spawn...`);
          const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore", env: browserEnv });
          child.unref();
          log(`xdg-open spawned with PID: ${child.pid}`);
          browserOpened = true;
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          log(`xdg-open spawn failed: ${errorMessage}`);
        }
      }

      // Method 3: Fallback to 'open' package (cross-platform)
      if (!browserOpened) {
        try {
          const open = (await import("open")).default;
          await open(url);
          browserOpened = true;
          log(`Launched with open package`);
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          log(`open package failed: ${errorMessage}`);
        }
      }

      if (!browserOpened) {
        log(`Could not open browser with any method`);
        logger.warn(`Please open manually: ${url}`);
        server.cancel();
        return `BROWSER_URL:${url}`;
      }

      log(`Browser opened, waiting for callback...`);

      const result = await server.waitForCallback(120000);

      if (result.timedOut || !result.data) {
        log(`Browser callback timed out or no data`);
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
        "/api/fetch-ui",
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
