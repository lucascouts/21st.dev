import { z } from "zod";
import { BaseTool } from "../utils/base-tool.js";
import { twentyFirstClient } from "../utils/http-client.js";
import { CallbackServer } from "../utils/callback-server.js";
import { getContentOfFile } from "../utils/get-content-of-file.js";
import { ShellSanitizer } from "../utils/shell-sanitizer.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("CreateUI");
const UI_TOOL_NAME = "magic_component_builder";
const UI_TOOL_DESCRIPTION = `
"Use this tool when the user requests a new UI component—e.g., mentions /ui, /21 /21st, or asks for a button, input, dialog, table, form, banner, card, or other React component.
This tool ONLY returns the text snippet for that UI component. 
After calling this tool, you must edit or add files to integrate the snippet into the codebase."
`;

/**
 * Cache for display environment detection (Requirements 10.2, 10.3)
 * Cached once per process lifetime to avoid repeated detection overhead
 */
interface DisplayEnvCache {
  env: Record<string, string>;
  detectedAt: number;
}

interface BrowserCache {
  browser: string | null;
  detectedAt: number;
}

let displayEnvCache: DisplayEnvCache | null = null;
let browserCache: BrowserCache | null = null;

/**
 * Exported for testing purposes - allows resetting the cache
 */
export function resetDisplayEnvCache(): void {
  displayEnvCache = null;
}

export function resetBrowserCache(): void {
  browserCache = null;
}

export function getDisplayEnvCacheState(): DisplayEnvCache | null {
  return displayEnvCache;
}

export function getBrowserCacheState(): BrowserCache | null {
  return browserCache;
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

  /**
   * Detects and returns display environment variables for X11 or Wayland
   * Reads from /proc to get the actual display session variables
   * Results are cached for the lifetime of the process (Requirements 10.2, 10.3)
   */
  private async getDisplayEnv(): Promise<Record<string, string>> {
    // Return cached result if available
    if (displayEnvCache !== null) {
      return displayEnvCache.env;
    }

    const fs = await import("fs");
    const env: Record<string, string> = {};
    
    // Get current user ID
    const uid = process.getuid?.() || 1000;
    
    // Default values
    env.HOME = process.env.HOME || `/home/${process.env.USER || 'user'}`;
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    
    // CRITICAL: D-Bus session bus address is required for xdg-open to work
    env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`;
    
    // Try to detect display type from loginctl or environment
    try {
      const { execSync } = await import("child_process");
      
      // Try to get session type from loginctl
      try {
        const sessionType = execSync("loginctl show-session $(loginctl | grep $(whoami) | awk '{print $1}') -p Type --value 2>/dev/null", {
          encoding: "utf-8",
          timeout: 2000,
        }).trim();
        
        if (sessionType) {
          env.XDG_SESSION_TYPE = sessionType;
        }
      } catch {
        // Fallback: check for Wayland socket
        const waylandSocket = `${env.XDG_RUNTIME_DIR}/wayland-0`;
        if (fs.existsSync(waylandSocket)) {
          env.XDG_SESSION_TYPE = "wayland";
        } else {
          env.XDG_SESSION_TYPE = "x11";
        }
      }
      
      // Set display variables based on session type
      if (env.XDG_SESSION_TYPE === "wayland") {
        env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || "wayland-0";
        // Wayland sessions often also have XWayland with DISPLAY
        env.DISPLAY = process.env.DISPLAY || ":0";
      } else {
        env.DISPLAY = process.env.DISPLAY || ":0";
      }
      
      // Try to read environment from a running GUI process (more reliable)
      try {
        const procs = fs.readdirSync("/proc").filter((p: string) => /^\d+$/.test(p));
        for (const pid of procs.slice(0, 100)) { // Check first 100 processes
          try {
            const environPath = `/proc/${pid}/environ`;
            const cmdlinePath = `/proc/${pid}/cmdline`;
            
            // Check if it's a GUI process (window manager, compositor, or desktop)
            const cmdline = fs.readFileSync(cmdlinePath, "utf-8");
            if (cmdline.includes("kwin") || cmdline.includes("gnome-shell") || 
                cmdline.includes("Xorg") || cmdline.includes("plasma") ||
                cmdline.includes("mutter") || cmdline.includes("sway")) {
              const environData = fs.readFileSync(environPath, "utf-8");
              const vars = environData.split("\0");
              
              for (const v of vars) {
                if (v.startsWith("DISPLAY=")) {
                  env.DISPLAY = v.split("=")[1];
                }
                if (v.startsWith("WAYLAND_DISPLAY=")) {
                  env.WAYLAND_DISPLAY = v.split("=")[1];
                }
                if (v.startsWith("DBUS_SESSION_BUS_ADDRESS=")) {
                  env.DBUS_SESSION_BUS_ADDRESS = v.split("=").slice(1).join("=");
                }
                if (v.startsWith("XDG_CURRENT_DESKTOP=")) {
                  env.XDG_CURRENT_DESKTOP = v.split("=")[1];
                }
                if (v.startsWith("DESKTOP_SESSION=")) {
                  env.DESKTOP_SESSION = v.split("=")[1];
                }
              }
              break;
            }
          } catch {
            // Skip inaccessible processes
          }
        }
      } catch {
        // /proc reading failed, use defaults
      }
      
    } catch {
      // Fallback to basic defaults
      env.DISPLAY = ":0";
    }
    
    // Cache the result for subsequent calls
    displayEnvCache = {
      env,
      detectedAt: Date.now(),
    };
    
    return env;
  }

  /**
   * Detects the default web browser on Linux using xdg-settings
   * Returns the browser name (e.g., 'firefox', 'google-chrome', 'brave') or null
   * Results are cached for the lifetime of the process (Requirements 10.2, 10.3)
   */
  private async getDefaultBrowser(): Promise<string | null> {
    // Return cached result if available
    if (browserCache !== null) {
      return browserCache.browser;
    }

    let browser: string | null = null;
    
    try {
      const { execSync } = await import("child_process");
      const result = execSync("xdg-settings get default-web-browser 2>/dev/null", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      
      // Extract browser name from .desktop file (e.g., "firefox.desktop" -> "firefox")
      if (result) {
        browser = result.replace(".desktop", "").toLowerCase();
      }
    } catch {
      // Ignore errors
    }
    
    // Cache the result for subsequent calls
    browserCache = {
      browser,
      detectedAt: Date.now(),
    };
    
    return browser;
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
      
      // Auto-detect display environment
      const displayEnv = await this.getDisplayEnv();
      log(`Detected display env: DISPLAY=${displayEnv.DISPLAY}, WAYLAND_DISPLAY=${displayEnv.WAYLAND_DISPLAY}, XDG_SESSION_TYPE=${displayEnv.XDG_SESSION_TYPE}`);
      
      // Detect default browser
      const defaultBrowser = await this.getDefaultBrowser();
      log(`Default browser detected: ${defaultBrowser || 'unknown'}`);
      
      const server = new CallbackServer();
      const port = await server.start();
      log(`Callback server started on port ${port}`);

      // Build URL and sanitize it for shell safety (Requirements 7.1, 7.2, 7.3)
      const rawUrl = `http://21st.dev/magic-chat?q=${encodeURIComponent(query)}&mcp=true&port=${port}`;
      let url: string;
      try {
        url = ShellSanitizer.sanitizeUrl(rawUrl);
      } catch (e: any) {
        log(`URL sanitization failed: ${e?.message || e}`);
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
        } catch (e: any) {
          log(`systemd-run failed: ${e?.message || e}`);
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
        } catch (e: any) {
          log(`xdg-open spawn failed: ${e?.message || e}`);
        }
      }

      // Method 3: Fallback to 'open' package (cross-platform)
      if (!browserOpened) {
        try {
          const open = (await import("open")).default;
          await open(url);
          browserOpened = true;
          log(`Launched with open package`);
        } catch (e: any) {
          log(`open package failed: ${e?.message || e}`);
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
      return {
        content: [{
          type: "text" as const,
          text: "// Failed to create component. Please try again or check your API key.",
        }],
      };
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
