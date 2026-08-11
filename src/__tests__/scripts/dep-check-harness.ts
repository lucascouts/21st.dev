/**
 * Fixture harness for `scripts/dep-check.sh` (story 003, R2.1-R2.2).
 *
 * The check shells out to three external binaries — `bun`, `osv-scanner` and
 * `trivy`. All three are the *system under test's* dependencies, so all three
 * are replaced by fixture programs here. `bash`, `jq`, `sed` and coreutils are
 * the *harness's own* dependencies and are not shimmed: reimplementing `jq`
 * would be reimplementing `jq`.
 *
 * Two rules make the suite hermetic, and both are load-bearing:
 *
 *  1. `PATH` is **replaced**, never prefixed. Prefixing leaves the maintainer's
 *     real `trivy` reachable, so "the scanner is absent from PATH" cannot be
 *     expressed at all on a developer machine — the exact defect this harness
 *     replaces (`dep-check.test.ts:57-59` before story 003).
 *  2. The replacement PATH is `<shim dir>:<harness bin dir>`, where the harness
 *     bin dir is a directory of symlinks to a fixed allowlist of text-processing
 *     tools that deliberately excludes `bun`, `osv-scanner` and `trivy`. Naming
 *     `/usr/bin` directly would smuggle the real binaries back in.
 *
 * Consequence: no scenario reaches the network, and the suite passes on a
 * machine — or a CI runner — that has never had either scanner installed.
 */

import { existsSync } from "node:fs";
import { mkdtemp, writeFile, chmod, symlink, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SCRIPT = "scripts/dep-check.sh";

/**
 * The repository root, found by walking up to the directory that owns the
 * script under test rather than counting `..` segments. Counting segments ties
 * the file to one position in the tree and breaks silently when it moves.
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, SCRIPT))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no directory above ${start} contains ${SCRIPT}`);
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(import.meta.dir);

/** Documented exit statuses: 0 clean, 1 findings, 2 incomplete. */
export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_INCOMPLETE = 2;

/** A fixture run is a handful of shell shims; nothing here should be slow. */
export const RUN_TIMEOUT_MS = 60_000;

/**
 * Tools the harness itself needs on PATH. `bun`, `osv-scanner` and `trivy` are
 * absent by construction — they only ever exist as shims.
 */
const HARNESS_BINARIES = [
  "bash", "sh", "env", "jq", "sed", "awk", "gawk", "grep", "egrep", "find",
  "mktemp", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "cat", "ls", "touch",
  "stat", "sort", "comm", "uniq", "join", "head", "tail", "tr", "cut", "wc",
  "diff", "xargs", "chmod", "tee", "timeout", "sleep", "date", "dirname",
  "basename", "realpath", "readlink", "printf", "true", "false", "test",
  "expr", "seq", "od", "md5sum", "sha256sum", "git",
];

/**
 * Tools without which the harness cannot run at all. The check encodes them as
 * its report format (`jq`) and its interpreter (`bash`, `sed`); a machine that
 * lacks one cannot produce a meaningful result, so the suite must say that
 * plainly instead of emitting four confusing `jq_not_found_on_path` events.
 */
const REQUIRED_HARNESS_BINARIES = ["bash", "jq", "sed"];

const harnessBinDirs = new Map<string, Promise<string>>();

/**
 * A PATH directory containing only the harness's own tools. Cached per omission
 * set; the absence of the three shimmed binaries is the point.
 *
 * @param omit names to leave OUT, so a scenario can assert what the check does
 *   when one of its own preconditions is missing.
 */
export function harnessBinDir(omit: readonly string[] = []): Promise<string> {
  const key = [...omit].sort().join(",");
  let pending = harnessBinDirs.get(key);
  if (!pending) {
    pending = (async () => {
      const dir = await mkdtemp(join(tmpdir(), "dep-check-harness-bin-"));
      for (const name of HARNESS_BINARIES) {
        if (omit.includes(name)) continue; // deliberately absent for this scenario
        const real = Bun.which(name);
        if (!real) {
          if (REQUIRED_HARNESS_BINARIES.includes(name)) {
            throw new Error(
              `harness dependency missing: ${name} is not on PATH. ` +
                `The dep-check suite drives the script with fixture binaries, but ` +
                `${REQUIRED_HARNESS_BINARIES.join(", ")} are the harness's own ` +
                `dependencies and cannot be shimmed.`,
            );
          }
          continue; // optional tool; a scenario that needs it will say so
        }
        await symlink(real, join(dir, name));
      }
      return dir;
    })();
    harnessBinDirs.set(key, pending);
  }
  return pending;
}

export interface CheckEvent {
  event: string;
  [key: string]: unknown;
}

export interface CheckRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout lines. */
  events: CheckEvent[];
  /** Non-null when some stdout line was not a JSON object. */
  parseError: string | null;
}

/** Stand-in for one scanner binary. */
export interface ScannerFixture {
  /** Report printed on stdout. Omit for no output at all. */
  report?: unknown;
  /** Exit status of the shim. Defaults to 0. */
  exit?: number;
  /** `false` leaves the binary off PATH entirely (the absent-scanner branch). */
  present?: boolean;
}

/** Stand-in for `bun`. */
export interface BunFixture {
  /**
   * Lockfile `bun install --lockfile-only` writes into its working directory —
   * i.e. what a re-resolution would resolve to today.
   */
  resolvedLock?: string;
  /** Exit status of `bun install`. Defaults to 0. */
  installExit?: number;
  /** Answers for `bun info <name> version --json`. */
  info?: Record<string, string>;
  /**
   * Shape of the `bun info` answer:
   *  - `string` (default) — a bare quoted JSON string, what the real command prints
   *  - `object` — `{"version":"..."}`, the shape a naive reader would assume
   *  - `fail`   — non-zero exit with no output
   */
  infoMode?: "string" | "object" | "fail";
  /** `false` leaves `bun` off PATH entirely. */
  present?: boolean;
}

export interface FixtureSpec {
  osv?: ScannerFixture;
  trivy?: ScannerFixture;
  bun?: BunFixture;
}

/** A real osv-scanner report with no findings (captured from osv-scanner 2.5.0). */
export const OSV_CLEAN = {
  results: [],
  experimental_config: { licenses: { summary: false, allowlist: null } },
};

/** A real osv-scanner report carrying `count` findings. */
export function osvWithFindings(count: number): unknown {
  return {
    results: [
      {
        source: { path: "bun.lock", type: "lockfile" },
        packages: [
          {
            package: { name: "fixture-pkg", version: "1.0.0", ecosystem: "npm" },
            vulnerabilities: Array.from({ length: count }, (_, i) => ({
              id: `GHSA-fixture-${i}`,
              summary: "fixture advisory",
            })),
          },
        ],
      },
    ],
    experimental_config: { licenses: { summary: false, allowlist: null } },
  };
}

/** A real trivy report with no findings (captured from trivy 0.73.0). */
export const TRIVY_CLEAN = {
  SchemaVersion: 2,
  ArtifactName: ".",
  ArtifactType: "filesystem",
  Results: [{ Target: "bun.lock", Class: "lang-pkgs", Type: "bun" }],
};

/** A real trivy report carrying `count` findings. */
export function trivyWithFindings(count: number): unknown {
  return {
    SchemaVersion: 2,
    ArtifactName: ".",
    ArtifactType: "filesystem",
    Results: [
      {
        Target: "bun.lock",
        Class: "lang-pkgs",
        Type: "bun",
        Vulnerabilities: Array.from({ length: count }, (_, i) => ({
          VulnerabilityID: `CVE-2026-000${i}`,
          PkgName: "fixture-pkg",
          InstalledVersion: "1.0.0",
          Severity: "HIGH",
        })),
      },
    ],
  };
}

async function writeShim(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/**
 * Builds a directory of fixture programs. Every shim ignores its arguments
 * except `bun`, which dispatches on its sub-command because the check asks it
 * two different questions.
 */
export async function makeShimDir(spec: FixtureSpec = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dep-check-shim-"));

  const scanners: Array<[string, ScannerFixture | undefined]> = [
    ["osv-scanner", spec.osv],
    ["trivy", spec.trivy],
  ];

  for (const [name, fixture] of scanners) {
    const conf = fixture ?? {};
    if (conf.present === false) continue; // absent from PATH: the not_found branch
    const reportPath = join(dir, `${name}-report.json`);
    const hasReport = conf.report !== undefined;
    if (hasReport) await writeFile(reportPath, `${JSON.stringify(conf.report, null, 2)}\n`);
    await writeShim(
      join(dir, name),
      [
        "#!/bin/bash",
        `# Fixture stand-in for ${name}; replays a recorded report, ignoring its args.`,
        hasReport ? `cat ${JSON.stringify(reportPath)}` : ":",
        `exit ${conf.exit ?? 0}`,
        "",
      ].join("\n"),
    );
  }

  const bunFixture = spec.bun ?? {};
  if (bunFixture.present !== false) {
    const lockPath = join(dir, "resolved.lock");
    const infoPath = join(dir, "info.json");
    const receiptPath = join(dir, "install-receipt.txt");
    const queriesPath = join(dir, "info-queries.txt");
    if (bunFixture.resolvedLock !== undefined) {
      await writeFile(lockPath, bunFixture.resolvedLock);
    }
    await writeFile(infoPath, `${JSON.stringify(bunFixture.info ?? {})}\n`);

    await writeShim(
      join(dir, "bun"),
      [
        "#!/bin/bash",
        "# Fixture stand-in for `bun`. Answers only what the check may ask.",
        "set -u",
        `readonly LOCK=${JSON.stringify(lockPath)}`,
        `readonly INFO=${JSON.stringify(infoPath)}`,
        `readonly RECEIPT=${JSON.stringify(receiptPath)}`,
        `readonly QUERIES=${JSON.stringify(queriesPath)}`,
        `readonly INFO_MODE=${JSON.stringify(bunFixture.infoMode ?? "string")}`,
        'case "${1:-}" in',
        "install)",
        "    # The real command prints its banner on STDOUT and its progress on",
        "    # stderr. Reproduced verbatim: a check that lets this stdout inherit",
        "    # corrupts the one-JSON-object-per-line contract.",
        "    printf 'bun install v1.3.14 (fixture)\\n'",
        "    printf 'Resolving dependencies\\n' >&2",
        "    # Receipt: where the re-resolution ran, and what was placed there.",
        "    # It is the only hermetic evidence that the isolated copy exists",
        "    # and carries the repository's own release-age policy.",
        '    printf \'%s\\n\' "$PWD" > "$RECEIPT"',
        '    ls -1 -a . >> "$RECEIPT"',
        '    if [ -f "$LOCK" ]; then cat "$LOCK" > ./bun.lock; fi',
        "    printf 'Saved lockfile\\n' >&2",
        `    exit ${bunFixture.installExit ?? 0}`,
        "    ;;",
        "info)",
        '    name="${2:-}"',
        "    # Query log: which packages the check asked about. Without it, an",
        "    # implementation that queries all 100 packages is indistinguishable",
        "    # from one that queries only the 5 this repository declares.",
        '    printf \'%s\\n\' "$name" >> "$QUERIES"',
        '    if [ "$INFO_MODE" = "fail" ]; then exit 1; fi',
        "    version=$(jq -r --arg n \"$name\" '.[$n] // \"\"' \"$INFO\")",
        '    if [ -z "$version" ]; then exit 1; fi   # unknown package: real bun exits non-zero',
        '    if [ "$INFO_MODE" = "object" ]; then',
        "        printf '{\"version\":\"%s\"}\\n' \"$version\"",
        "    else",
        "        # `bun info <pkg> version --json` prints a bare quoted string.",
        "        printf '\"%s\"\\n' \"$version\"",
        "    fi",
        "    ;;",
        "*)",
        "    # Any other sub-command answers nothing. `bun outdated` in",
        "    # particular is not a source of freshness any more (story 003 R1.1):",
        "    # it can only ever see the declared dependencies.",
        "    :",
        "    ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
  }

  return dir;
}

/**
 * Runs the check with `PATH` replaced by `<shimDir>:<harness bin dir>` and a
 * minimal environment. Nothing of the caller's environment is inherited, so a
 * variable that happens to be set on a developer machine cannot change the run.
 */
export interface RunOptions {
  /** Harness tools to leave off PATH, e.g. `["jq"]` for the preflight ladder. */
  omitHarnessTools?: readonly string[];
}

export async function runCheck(shimDir: string, options: RunOptions = {}): Promise<CheckRun> {
  const binDir = await harnessBinDir(options.omitHarnessTools ?? []);
  const home = await mkdtemp(join(tmpdir(), "dep-check-home-"));

  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      PATH: `${shimDir}:${binDir}`,
      HOME: home,
      TMPDIR: tmpdir(),
      LANG: "C",
      LC_ALL: "C",
    },
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
      const parsed: unknown = JSON.parse(line);
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

/** Convenience: build the fixtures and run in one step. */
export async function runWithFixtures(
  spec: FixtureSpec,
  options: RunOptions = {},
): Promise<CheckRun> {
  return runCheck(await makeShimDir(spec), options);
}

export function eventsOfType(run: CheckRun, type: string): CheckEvent[] {
  return run.events.filter((event) => event.event === type);
}

export function scannerEvent(run: CheckRun, scanner: string): CheckEvent | undefined {
  return eventsOfType(run, "scanner").find((event) => event.scanner === scanner);
}

export function freshnessEvent(run: CheckRun): CheckEvent | undefined {
  return eventsOfType(run, "freshness")[0];
}

export function summaryEvent(run: CheckRun): CheckEvent | undefined {
  return eventsOfType(run, "summary")[0];
}

/** A failure message carrying the run's own output, so a red is diagnosable. */
export function describeRun(run: CheckRun): string {
  return `exit=${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
}

export interface LockEntry {
  /** Lockfile key. Nested resolutions exist, e.g. `body-parser/content-type`. */
  key: string;
  /** Package name. Differs from the key on a nested resolution. */
  name: string;
  version: string;
}

/**
 * Reads `bun.lock`. It is JSONC — trailing commas make it unreadable to `jq` —
 * so both the check and this harness extract the `"key": ["name@version"` rows
 * with a regex. Scoped names carry a leading `@`, so the version is whatever
 * follows the LAST `@`.
 */
export function parseLockEntries(lockText: string): LockEntry[] {
  const entries: LockEntry[] = [];
  for (const line of lockText.split("\n")) {
    const match = /^\s*"([^"]+)":\s*\["([^"]+)"/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const entry = match[2] as string;
    const at = entry.lastIndexOf("@");
    if (at <= 0) continue;
    entries.push({ key, name: entry.slice(0, at), version: entry.slice(at + 1) });
  }
  return entries;
}

/** Rewrites one entry's version in a lockfile, leaving every other byte alone. */
export function rewriteLockVersion(
  lockText: string,
  key: string,
  from: string,
  to: string,
): string {
  let rewritten = 0;
  const out = lockText.split("\n").map((line) => {
    const match = /^\s*"([^"]+)":\s*\["([^"]+)"/.exec(line);
    if (!match || match[1] !== key) return line;
    rewritten += 1;
    const entry = match[2] as string;
    return line.replace(`"${entry}"`, `"${entry.replace(`@${from}`, `@${to}`)}"`);
  });
  if (rewritten !== 1) {
    throw new Error(`expected exactly one lockfile row for key ${key}, rewrote ${rewritten}`);
  }
  return out.join("\n");
}

/** Bumps the patch component, so the fixture drift is always a real upgrade. */
export function bumpPatch(version: string): string {
  const parts = version.split(".");
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  return [parts[0] ?? "0", parts[1] ?? "0", String(Number.isNaN(patch) ? 1 : patch + 1)].join(".");
}

/**
 * Creates a marker file OUTSIDE the repository and waits for the filesystem
 * clock to move past it, so that "written after the marker" is unambiguous even
 * on a filesystem with one-second mtime granularity.
 */
export async function createWriteMarker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dep-check-marker-"));
  const marker = join(dir, "marker");
  await writeFile(marker, "");
  await Bun.sleep(1100);
  return marker;
}

/**
 * Every path in the working tree modified since the marker. Deliberately
 * enumerates nothing in advance: `dist/` and `node_modules/` are gitignored and
 * are exactly where a lifecycle-script write would land, so they stay in scope.
 * `.git` is pruned as noise and `.epic` because the story framework writes there
 * while the suite runs.
 */
export async function pathsWrittenSince(marker: string): Promise<string[]> {
  const binDir = await harnessBinDir();
  const proc = Bun.spawn(
    [
      "find", ".",
      "-path", "./.git", "-prune", "-o",
      "-path", "./.epic", "-prune", "-o",
      "-newer", marker, "-print",
    ],
    {
      cwd: REPO_ROOT,
      env: { PATH: binDir, HOME: tmpdir(), LANG: "C", LC_ALL: "C" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // A `find` that died returns no paths, which reads exactly like "nothing was
  // written". Refusing to answer is the only honest outcome.
  if (exitCode !== 0) {
    throw new Error(`the write guard could not run: find exited ${exitCode}\n${stderr}`);
  }

  return stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Names declared in `package.json` — the packages whose semver range this
 * repository owns. Everything else in the lockfile is transitive.
 */
export function directDependencyNames(packageJsonText: string): string[] {
  const manifest = JSON.parse(packageJsonText) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
}


export interface InstallReceipt {
  /** Working directory the re-resolution ran in. */
  cwd: string;
  /** Entries present in that directory when the re-resolution started. */
  entries: string[];
}

/**
 * What the `bun` shim recorded about the re-resolution, or `null` when no
 * re-resolution happened at all.
 */
export async function readInstallReceipt(shimDir: string): Promise<InstallReceipt | null> {
  const file = Bun.file(join(shimDir, "install-receipt.txt"));
  if (!(await file.exists())) return null;
  const [cwd = "", ...entries] = (await file.text()).split("\n");
  return {
    cwd,
    entries: entries.filter((entry) => entry !== "" && entry !== "." && entry !== ".."),
  };
}

/**
 * Package names the check asked `bun info` about, in query order. Empty when it
 * asked about nothing.
 */
export async function readInfoQueries(shimDir: string): Promise<string[]> {
  const file = Bun.file(join(shimDir, "info-queries.txt"));
  if (!(await file.exists())) return [];
  return (await file.text()).split("\n").filter((line) => line.trim() !== "");
}

/** Reads a file from the repository working tree. */
export async function readRepoFile(relativePath: string): Promise<string> {
  return Bun.file(join(REPO_ROOT, relativePath)).text();
}

/** True when the path exists in the repository working tree. */
export async function repoPathExists(relativePath: string): Promise<boolean> {
  try {
    await stat(join(REPO_ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

/** Ensures a nested directory exists (used by fixtures that build a tree). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
