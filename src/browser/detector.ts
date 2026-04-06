import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import type { Logger } from "../logger.js";
import { ShellSanitizer } from "../security/shell-sanitizer.js";

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

const BROWSER_MAP: Record<string, string[]> = {
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

const FIREFOX_BASED = ["firefox", "librewolf", "waterfox", "zen"];

export class BrowserDetector {
  private readonly logger: Logger;
  private displayEnvCache: DisplayEnvironment | null = null;
  private defaultBrowserCache: string | null | undefined = undefined;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  getDisplayEnv(): DisplayEnvironment {
    if (this.displayEnvCache) return this.displayEnvCache;

    const uid = process.getuid?.() ?? 1000;
    const env: DisplayEnvironment = {
      HOME: process.env.HOME || `/home/${process.env.USER || "user"}`,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS:
        process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
    };

    // Detect session type
    try {
      const username = execSync("whoami", { encoding: "utf-8", timeout: 1000 }).trim();
      const loginctlOutput = execSync("loginctl --no-legend", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      const sessionLine = loginctlOutput.split("\n").find((l) => l.includes(username));
      const sessionId = sessionLine?.trim().split(/\s+/)[0];

      if (sessionId) {
        const sessionType = execSync(
          `loginctl show-session ${sessionId} -p Type --value`,
          { encoding: "utf-8", timeout: 2000 }
        ).trim();
        if (sessionType) env.XDG_SESSION_TYPE = sessionType;
      }
    } catch {
      const waylandSocket = `${env.XDG_RUNTIME_DIR}/wayland-0`;
      env.XDG_SESSION_TYPE = existsSync(waylandSocket) ? "wayland" : "x11";
    }

    if (env.XDG_SESSION_TYPE === "wayland") {
      env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || "wayland-0";
      env.DISPLAY = process.env.DISPLAY || ":0";
    } else {
      env.DISPLAY = process.env.DISPLAY || ":0";
    }

    // Read from GUI process
    this.readEnvFromGuiProcess(uid, env);

    this.displayEnvCache = env;
    return env;
  }

  getDefaultBrowser(): string | null {
    if (this.defaultBrowserCache !== undefined) return this.defaultBrowserCache;

    let browser: string | null = null;
    try {
      const result = execSync("xdg-settings get default-web-browser 2>/dev/null", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      if (result) {
        browser = result.replace(".desktop", "").toLowerCase();
      }
    } catch {
      // ignore
    }

    this.defaultBrowserCache = browser;
    return browser;
  }

  async openUrl(url: string): Promise<boolean> {
    try {
      const sanitizedUrl = ShellSanitizer.sanitizeUrl(url);
      const displayEnv = this.getDisplayEnv();
      const defaultBrowser = this.getDefaultBrowser();

      const browserEnv = {
        ...process.env,
        ...displayEnv,
        DISPLAY: process.env.DISPLAY || displayEnv.DISPLAY || ":0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || displayEnv.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS:
          process.env.DBUS_SESSION_BUS_ADDRESS || displayEnv.DBUS_SESSION_BUS_ADDRESS,
      };

      // Method 1: systemd-run with detected browser
      if (defaultBrowser) {
        try {
          const { cmd, args } = this.findBrowserCommand(defaultBrowser);
          const systemdArgs = ["--user", "--no-block", "--collect", cmd, ...args, sanitizedUrl];
          this.logger.debug(`systemd-run ${systemdArgs.join(" ")}`);

          const child = spawn("systemd-run", systemdArgs, {
            env: browserEnv,
            stdio: "ignore",
            timeout: 5000,
          });

          await new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.on("spawn", () => resolve());
            setTimeout(resolve, 1000);
          });

          return true;
        } catch (e) {
          this.logger.debug(`systemd-run failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Method 2: xdg-open
      try {
        const child = spawn("xdg-open", [sanitizedUrl], {
          detached: true,
          stdio: "ignore",
          env: browserEnv,
        });
        child.unref();
        return true;
      } catch (e) {
        this.logger.debug(`xdg-open failed: ${e instanceof Error ? e.message : e}`);
      }

      // Method 3: direct spawn of detected browser
      if (defaultBrowser) {
        try {
          const { cmd, args } = this.findBrowserCommand(defaultBrowser);
          const child = spawn(cmd, [...args, sanitizedUrl], {
            detached: true,
            stdio: "ignore",
            env: browserEnv,
          });
          child.unref();
          return true;
        } catch (e) {
          this.logger.debug(`Direct spawn failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      return false;
    } catch (error) {
      this.logger.error("Browser open error:", error);
      return false;
    }
  }

  private findBrowserCommand(browser: string): { cmd: string; args: string[] } {
    let candidates: string[] = [];
    for (const [key, executables] of Object.entries(BROWSER_MAP)) {
      if (browser.includes(key)) {
        candidates = executables;
        break;
      }
    }
    if (candidates.length === 0) candidates = ["xdg-open"];

    for (const candidate of candidates) {
      try {
        execSync(`which ${candidate}`, { encoding: "utf-8", timeout: 1000 });
        const args = FIREFOX_BASED.some((b) => candidate.includes(b)) ? ["--new-tab"] : [];
        return { cmd: candidate, args };
      } catch {
        // not found
      }
    }

    return { cmd: "xdg-open", args: [] };
  }

  private readEnvFromGuiProcess(uid: number, env: DisplayEnvironment): void {
    const currentUid = String(uid);
    try {
      const procs = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
      for (const pid of procs.slice(0, 100)) {
        try {
          const statusContent = readFileSync(`/proc/${pid}/status`, "utf-8");
          const uidLine = statusContent.split("\n").find((l) => l.startsWith("Uid:"));
          if (!uidLine || !uidLine.includes(currentUid)) continue;

          const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
          if (
            !cmdline.includes("kwin") &&
            !cmdline.includes("gnome-shell") &&
            !cmdline.includes("Xorg") &&
            !cmdline.includes("plasma") &&
            !cmdline.includes("mutter") &&
            !cmdline.includes("sway")
          ) continue;

          const environData = readFileSync(`/proc/${pid}/environ`, "utf-8");
          const vars = environData.split("\0");

          for (const v of vars) {
            if (v.startsWith("DISPLAY=")) env.DISPLAY = v.split("=")[1];
            if (v.startsWith("WAYLAND_DISPLAY=")) env.WAYLAND_DISPLAY = v.split("=")[1];
            if (v.startsWith("DBUS_SESSION_BUS_ADDRESS="))
              env.DBUS_SESSION_BUS_ADDRESS = v.split("=").slice(1).join("=");
            if (v.startsWith("XDG_CURRENT_DESKTOP=")) env.XDG_CURRENT_DESKTOP = v.split("=")[1];
            if (v.startsWith("DESKTOP_SESSION=")) env.DESKTOP_SESSION = v.split("=")[1];
          }
          break;
        } catch {
          // Skip inaccessible processes
        }
      }
    } catch {
      // /proc reading failed
    }
  }
}
