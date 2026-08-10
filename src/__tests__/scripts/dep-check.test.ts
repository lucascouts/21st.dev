import { describe, it, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Integration contract for `scripts/dep-check.sh` (story 002, R1.1-R1.5).
 *
 * The script is the deliverable, so what must be pinned is its *observable*
 * contract, not its internals: the shape of what it prints, the exit codes it
 * documents, and the guarantee that it writes nothing.
 *
 * Output contract — one JSON object per line on stdout, no prose:
 *
 *   {"event":"scanner","scanner":"osv-scanner","status":"ok","vulnerabilities":0}
 *   {"event":"scanner","scanner":"trivy","status":"ok","vulnerabilities":0}
 *   {"event":"freshness","status":"ok","outdated_count":0,"outdated":[]}
 *   {"event":"summary","exit_code":0,"vulnerabilities":0,"outdated_count":0,"scanners_errored":0}
 *
 * A `scanner` or `freshness` event with status "errored" carries no count.
 *
 * Exit codes: 0 = clean and current (R1.4) | 1 = updates available or
 * vulnerabilities found (R1.3) | 2 = a scanner errored (R1.5).
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = "scripts/dep-check.sh";

const DOCUMENTED_EXIT_CODES = [0, 1, 2];
/** trivy scans the whole tree; give the real run room without hanging CI forever. */
const RUN_TIMEOUT_MS = 300_000;
/** Files R1.1 forbids the check from touching. */
const GUARDED_MANIFESTS = ["bun.lock", "package.json"];

interface CheckEvent {
  event: string;
  [key: string]: unknown;
}

interface CheckRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout lines, or [] when a line failed to parse. */
  events: CheckEvent[];
  /** Non-null when some stdout line was not a JSON object. */
  parseError: string | null;
}

async function sha256(relativePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(resolve(REPO_ROOT, relativePath)))
    .digest("hex");
}

async function runCheck(extraPath?: string): Promise<CheckRun> {
  const env = { ...process.env };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH ?? ""}`;

  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const events: CheckEvent[] = [];
  let parseError: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        parseError ??= `line is not a JSON object: ${line}`;
        continue;
      }
      events.push(parsed as CheckEvent);
    } catch {
      parseError ??= `line is not valid JSON: ${line}`;
    }
  }

  if (lines.length === 0) parseError ??= "the script produced no stdout at all";

  return { exitCode, stdout, stderr, events, parseError };
}

function eventsOfType(run: CheckRun, type: string): CheckEvent[] {
  return run.events.filter((event) => event.event === type);
}

function scannerEvent(run: CheckRun, scanner: string): CheckEvent | undefined {
  return eventsOfType(run, "scanner").find((event) => event.scanner === scanner);
}

describe("scripts/dep-check.sh", () => {
  let run: CheckRun;
  let manifestsBefore: string[];
  let manifestsAfter: string[];
  let nodeModulesBefore: number;
  let nodeModulesAfter: number;

  beforeAll(async () => {
    manifestsBefore = await Promise.all(GUARDED_MANIFESTS.map(sha256));
    nodeModulesBefore = (await readdir(join(REPO_ROOT, "node_modules"))).length;

    run = await runCheck();

    manifestsAfter = await Promise.all(GUARDED_MANIFESTS.map(sha256));
    nodeModulesAfter = (await readdir(join(REPO_ROOT, "node_modules"))).length;
  }, RUN_TIMEOUT_MS);

  describe("output contract", () => {
    it("emits only parseable JSON lines on stdout", () => {
      expect(run.parseError).toBeNull();
    });

    it("reports a status for osv-scanner (R1.2)", () => {
      const event = scannerEvent(run, "osv-scanner");
      expect(event).toBeDefined();
      expect(["ok", "errored"]).toContain(event?.status as string);
    });

    it("reports a status for trivy (R1.2)", () => {
      const event = scannerEvent(run, "trivy");
      expect(event).toBeDefined();
      expect(["ok", "errored"]).toContain(event?.status as string);
    });

    it("reports a vulnerability count for every scanner that succeeded (R1.2)", () => {
      const succeeded = eventsOfType(run, "scanner").filter((e) => e.status === "ok");
      expect(succeeded.length).toBeGreaterThan(0);
      for (const event of succeeded) {
        expect(Number.isInteger(event.vulnerabilities)).toBe(true);
        expect(event.vulnerabilities as number).toBeGreaterThanOrEqual(0);
      }
    });

    it("reports freshness with a count and the outdated-package list (R1.1)", () => {
      const [event, ...rest] = eventsOfType(run, "freshness");
      expect(event).toBeDefined();
      expect(rest).toHaveLength(0);
      expect(["ok", "errored"]).toContain(event?.status as string);

      if (event?.status === "ok") {
        expect(Number.isInteger(event.outdated_count)).toBe(true);
        expect(Array.isArray(event.outdated)).toBe(true);
        expect((event.outdated as unknown[]).length).toBe(event.outdated_count as number);
      }
    });

    it("closes with exactly one summary event carrying every declared field", () => {
      const summaries = eventsOfType(run, "summary");
      expect(summaries).toHaveLength(1);

      const summary = summaries[0]!;
      for (const field of ["exit_code", "vulnerabilities", "outdated_count", "scanners_errored"]) {
        expect(Number.isInteger(summary[field])).toBe(true);
      }
      expect(run.events.at(-1)).toBe(summary);
    });

    it("keeps prose out of stdout", () => {
      // Every non-blank stdout line parsed as JSON above; this pins that stdout
      // carries nothing else, so a caller can pipe it straight into jq.
      const nonBlank = run.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(run.events).toHaveLength(nonBlank.length);
    });
  });

  describe("exit-code contract", () => {
    it("exits with one of the three documented codes", () => {
      expect(DOCUMENTED_EXIT_CODES).toContain(run.exitCode);
    });

    it("agrees with the code it reported in the summary", () => {
      expect(eventsOfType(run, "summary")[0]?.exit_code).toBe(run.exitCode);
    });

    it("exits non-zero when it found vulnerabilities or updates (R1.3)", () => {
      const summary = eventsOfType(run, "summary")[0]!;
      const found = (summary.vulnerabilities as number) + (summary.outdated_count as number);
      if (found > 0) expect(run.exitCode).not.toBe(0);
    });

    it("exits zero only on a clean, current, fully-scanned tree (R1.4)", () => {
      if (run.exitCode !== 0) return;
      const summary = eventsOfType(run, "summary")[0]!;
      expect(summary.vulnerabilities).toBe(0);
      expect(summary.outdated_count).toBe(0);
      expect(summary.scanners_errored).toBe(0);
    });

    it("exits 2 when any scanner errored (R1.5)", () => {
      const summary = eventsOfType(run, "summary")[0]!;
      if ((summary.scanners_errored as number) > 0) expect(run.exitCode).toBe(2);
    });
  });

  describe("R1.5 — partial coverage never reads as clean", () => {
    it("reports the scanner as errored and exits 2 when it fails", async () => {
      // A trivy that dies without output is the failure mode this story exists to
      // prevent: a skipped scan must never be indistinguishable from a clean one.
      const shimDir = await mkdtemp(join(tmpdir(), "dep-check-shim-"));
      const shim = join(shimDir, "trivy");
      await writeFile(shim, "#!/bin/sh\nexit 127\n");
      await chmod(shim, 0o755);

      const masked = await runCheck(shimDir);

      expect(scannerEvent(masked, "trivy")?.status).toBe("errored");
      expect(eventsOfType(masked, "summary")[0]?.scanners_errored).toBeGreaterThan(0);
      expect(masked.exitCode).toBe(2);
    }, RUN_TIMEOUT_MS);
  });

  describe("R1.1/R1.7 — the check writes nothing", () => {
    it("leaves bun.lock and package.json byte-identical", () => {
      expect(manifestsAfter).toEqual(manifestsBefore);
    });

    it("installs nothing into node_modules", () => {
      expect(nodeModulesAfter).toBe(nodeModulesBefore);
    });
  });
});
