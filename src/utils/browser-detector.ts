import { Logger } from "./logger.js";

const logger = new Logger("BrowserDetector");

/**
 * Display environment variables for X11 or Wayland sessions
 * Requirements: C1.1, C1.2
 */
export interface DisplayEnvironment {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  XDG_SESSION_TYPE?: string;
  XDG_RUNTIME_DIR?: string;
  DBUS_SESSION_BUS_ADDRESS?: string;
  HOME?: string;
  XDG_CURRENT_DESKTOP?: string;
  DESKTOP_SESSION?: string;
}

/**
 * Cache structure for browser detection results
 * Requirements: C1.3 - Maintain existing caching behavior
 */
interface BrowserDetectorCache {
  displayEnv: DisplayEnvironment | null;
  defaultBrowser: string | null;
  detectedAt: number;
}

/**
 * Browser detector module for detecting display environment and default browser
 * Requirements: C1.1-C1.3
 */
export class BrowserDetector {
  private static cache: BrowserDetectorCache | null = null;

  /**
   * Detect display environment (X11/Wayland)
   * Results are cached for process lifetime
   * Requirements: C1.2, C1.3
   */
  static async getDisplayEnv(): Promise<DisplayEnvironment> {
    // Return cached result if available
    if (this.cache?.displayEnv !== null && this.cache?.displayEnv !== undefined) {
      return this.cache.displayEnv;
    }

    const fs = await import("fs");
    const env: DisplayEnvironment = {};

    // Get current user ID
    const uid = process.getuid?.() || 1000;

    // Default values
    env.HOME = process.env.HOME || `/home/${process.env.USER || "user"}`;
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;

    // CRITICAL: D-Bus session bus address is required for xdg-open to work
    env.DBUS_SESSION_BUS_ADDRESS =
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`;

    // Try to detect display type from loginctl or environment
    try {
      const { execSync } = await import("child_process");

      // Try to get session type from loginctl
      try {
        const sessionType = execSync(
          "loginctl show-session $(loginctl | grep $(whoami) | awk '{print $1}') -p Type --value 2>/dev/null",
          {
            encoding: "utf-8",
            timeout: 2000,
          }
        ).trim();

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
        for (const pid of procs.slice(0, 100)) {
          // Check first 100 processes
          try {
            const environPath = `/proc/${pid}/environ`;
            const cmdlinePath = `/proc/${pid}/cmdline`;

            // Check if it's a GUI process (window manager, compositor, or desktop)
            const cmdline = fs.readFileSync(cmdlinePath, "utf-8");
            if (
              cmdline.includes("kwin") ||
              cmdline.includes("gnome-shell") ||
              cmdline.includes("Xorg") ||
              cmdline.includes("plasma") ||
              cmdline.includes("mutter") ||
              cmdline.includes("sway")
            ) {
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

    // Initialize cache if needed and store result
    if (!this.cache) {
      this.cache = {
        displayEnv: null,
        defaultBrowser: null,
        detectedAt: Date.now(),
      };
    }
    this.cache.displayEnv = env;
    this.cache.detectedAt = Date.now();

    return env;
  }

  /**
   * Detect default web browser using xdg-settings
   * Returns the browser name (e.g., 'firefox', 'google-chrome', 'brave') or null
   * Results are cached for process lifetime
   * Requirements: C1.2, C1.3
   */
  static async getDefaultBrowser(): Promise<string | null> {
    // Return cached result if available
    if (this.cache?.defaultBrowser !== undefined && this.cache?.defaultBrowser !== null) {
      return this.cache.defaultBrowser;
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

    // Initialize cache if needed and store result
    if (!this.cache) {
      this.cache = {
        displayEnv: null,
        defaultBrowser: null,
        detectedAt: Date.now(),
      };
    }
    this.cache.defaultBrowser = browser;
    this.cache.detectedAt = Date.now();

    return browser;
  }

  /**
   * Open URL in browser with proper environment
   * Requirements: C1.3 (new helper method)
   * @returns true if browser was opened successfully, false otherwise
   */
  static async openUrl(url: string): Promise<boolean> {
    const fs = await import("fs");
    const { execSync, spawn } = await import("child_process");

    try {
      // Auto-detect display environment
      const displayEnv = await this.getDisplayEnv();
      logger.debug(
        `Detected display env: DISPLAY=${displayEnv.DISPLAY}, WAYLAND_DISPLAY=${displayEnv.WAYLAND_DISPLAY}`
      );

      // Detect default browser
      const defaultBrowser = await this.getDefaultBrowser();
      logger.debug(`Default browser detected: ${defaultBrowser || "unknown"}`);

      // Build environment with detected values
      const browserEnv = {
        ...process.env,
        ...displayEnv,
        DISPLAY: process.env.DISPLAY || displayEnv.DISPLAY || ":0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || displayEnv.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS:
          process.env.DBUS_SESSION_BUS_ADDRESS || displayEnv.DBUS_SESSION_BUS_ADDRESS,
      };

      let browserOpened = false;

      // Method 1: Use systemd-run (works best in Linux desktop sessions)
      if (defaultBrowser) {
        try {
          logger.debug(`Default browser: ${defaultBrowser}, using systemd-run...`);

          // Map browser desktop file names to possible executable names
          const browserMap: Record<string, string[]> = {
            firefox: ["firefox", "firefox-esr"],
            chrome: ["google-chrome-stable", "google-chrome", "chrome"],
            brave: ["brave-browser-stable", "brave-browser", "brave"],
            chromium: ["chromium", "chromium-browser"],
            vivaldi: ["vivaldi-stable", "vivaldi"],
            opera: ["opera-stable", "opera"],
            edge: ["microsoft-edge-stable", "microsoft-edge", "msedge"],
            zen: ["zen-browser", "zen"],
            librewolf: ["librewolf"],
            waterfox: ["waterfox"],
            thorium: ["thorium-browser", "thorium"],
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
              if (["firefox", "librewolf", "waterfox", "zen"].some((b) => candidate.includes(b))) {
                browserArgs = ["--new-tab"];
              }
              logger.debug(`Found executable: ${browserCmd}`);
              break;
            } catch {
              // Executable not found, try next
            }
          }

          if (!browserCmd) {
            browserCmd = "xdg-open";
            logger.debug(`No executable found, falling back to xdg-open`);
          }

          // Use array-based spawn arguments for security
          const systemdArgs = ["--user", "--no-block", "--collect", browserCmd, ...browserArgs, url];
          logger.debug(`Browser command: systemd-run ${systemdArgs.join(" ")}`);

          const child = spawn("systemd-run", systemdArgs, {
            env: browserEnv,
            stdio: "ignore",
            timeout: 5000,
          });

          // Wait briefly for spawn to complete
          await new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.on("spawn", () => {
              logger.debug(`Launched ${browserCmd} via systemd-run`);
              resolve();
            });
            // Timeout fallback
            setTimeout(resolve, 1000);
          });

          browserOpened = true;
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          logger.debug(`systemd-run failed: ${errorMessage}`);
        }
      }

      // Method 2: Try spawn with xdg-open
      if (!browserOpened) {
        try {
          logger.debug(`Attempting xdg-open spawn...`);
          const child = spawn("xdg-open", [url], {
            detached: true,
            stdio: "ignore",
            env: browserEnv,
          });
          child.unref();
          logger.debug(`xdg-open spawned with PID: ${child.pid}`);
          browserOpened = true;
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          logger.debug(`xdg-open spawn failed: ${errorMessage}`);
        }
      }

      // Method 3: Fallback to 'open' package (cross-platform)
      if (!browserOpened) {
        try {
          const open = (await import("open")).default;
          await open(url);
          browserOpened = true;
          logger.debug(`Launched with open package`);
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          logger.debug(`open package failed: ${errorMessage}`);
        }
      }

      return browserOpened;
    } catch (error) {
      logger.error(`Browser open error:`, error);
      return false;
    }
  }

  /**
   * Reset cache (for testing)
   * Requirements: C1.3
   */
  static resetCache(): void {
    this.cache = null;
  }

  /**
   * Get cache state (for testing)
   */
  static getCacheState(): BrowserDetectorCache | null {
    return this.cache;
  }
}

// Export standalone functions for backward compatibility
export async function getDisplayEnv(): Promise<DisplayEnvironment> {
  return BrowserDetector.getDisplayEnv();
}

export async function getDefaultBrowser(): Promise<string | null> {
  return BrowserDetector.getDefaultBrowser();
}

export function resetDisplayEnvCache(): void {
  BrowserDetector.resetCache();
}

export function resetBrowserCache(): void {
  BrowserDetector.resetCache();
}
