import { describe, it, expect, beforeAll } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_INCOMPLETE,
  OSV_CLEAN,
  REPO_ROOT,
  RUN_TIMEOUT_MS,
  TRIVY_CLEAN,
  createWriteMarker,
  describeRun,
  directDependencyNames,
  eventsOfType,
  freshnessEvent,
  harnessBinDir,
  makeShimDir,
  osvWithFindings,
  parseLockEntries,
  pathsWrittenSince,
  readRepoFile,
  runCheck,
  scannerEvent,
  summaryEvent,
  trivyWithFindings,
  type BunFixture,
  type CheckRun,
} from "./dep-check-harness.js";

/**
 * Integration contract for `scripts/dep-check.sh`
 * (story 002 R1.1-R1.5; story 003 R2.1-R2.5 and R3.1).
 *
 * The script is the deliverable, so what is pinned here is its *observable*
 * contract, not its internals: one JSON object per line on stdout with every
 * human-facing word on stderr, one event per scanner, and the exit status each
 * documented failure branch produces.
 *
 *   {"event":"scanner","scanner":"osv-scanner","status":"ok","vulnerabilities":0}
 *   {"event":"scanner","scanner":"trivy","status":"errored","reason":"exit_status_127"}
 *   {"event":"freshness","status":"ok","outdated_count":0,"outdated":[]}
 *   {"event":"summary","exit_code":2,...,"scanners_errored":1}
 *
 * An errored event carries a `reason` and NO count: an absent count must never
 * be read as a zero count.
 *
 * Exit statuses: 0 clean · 1 findings · 2 incomplete, and 2 outranks 1 — a check
 * that could not see everything must never read as a passing one (R2.5).
 *
 * WHAT IS A FIXTURE AND WHAT IS NOT (R2.1/R2.2)
 *
 * The script's own dependencies — `osv-scanner`, `trivy` and `bun` — are all
 * replaced by fixture programs, so every scenario below is deterministic and no
 * scenario reaches the network. `bash`, `jq`, `sed` and coreutils are NOT the
 * system under test: they are the *harness's own* dependencies, and shimming
 * `jq` would mean reimplementing `-nc --arg`, `-Rsc` and the count filters —
 * i.e. reimplementing `jq`. The one honest `jq` fixture is its **absence**,
 * which is what the preflight scenario at the bottom of this file exercises.
 *
 * That dependency is worth stating out loud: no CI step installs `jq`, so the
 * evidence these tests produce silently relies on the runner image shipping it.
 * `dep-check-harness.ts` therefore hard-fails when `bash`, `jq` or `sed` cannot
 * be found, instead of emitting a confusing cascade of `jq_not_found_on_path`.
 *
 * `PATH` is *replaced*, never prefixed (see the harness). Prefixing left the
 * maintainer's real `trivy` reachable, so "the scanner is absent" could not be
 * expressed at all on a developer machine — and neither could a run on a machine
 * where no scanner has ever been installed.
 */

/** Exit statuses the script's header documents; anything else is a contract break. */
const DOCUMENTED_EXIT_CODES = [EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE];

/** Both scanners run to completion and find nothing. */
const CLEAN_SCANNERS = {
  osv: { report: OSV_CLEAN, exit: 0 },
  trivy: { report: TRIVY_CLEAN, exit: 0 },
} as const;

/**
 * The `bun` fixture every scenario shares: a re-resolution that reproduces the
 * repository's own lockfile byte-for-byte, and a registry that answers with the
 * version already installed. It says "the tree is current" and nothing else.
 *
 * Configuring it is NOT optional — but the reason is a future one, so it is
 * stated precisely. Against the script as it stands today an omitted `spec.bun`
 * is harmless: `bun outdated` reaches the shim's default branch, prints nothing,
 * exits 0, and freshness reports `ok`. Once freshness is computed by
 * re-resolution, an absent `resolved.lock` describes a re-resolution that
 * produced nothing — a *failed* one — and every scenario below would exit 2 for
 * that reason instead of its own. The precedence scenario in particular would
 * stay green while proving nothing, since its expected status is also 2. A guard
 * that is green for the wrong reason is the defect class this story exists to
 * close, so the fixture is configured now, before it can start lying.
 */
let currentTree: BunFixture;

let cleanRun: CheckRun;
let findingsRun: CheckRun;
let absentRun: CheckRun;
let absentShimDir: string;
let abnormalRun: CheckRun;
let precedenceRun: CheckRun;
let jqAbsentRun: CheckRun;

/** Every scenario, labelled, for the contracts that must hold of all of them. */
let allRuns: Array<[string, CheckRun]>;

beforeAll(async () => {
  const repoLock = await readRepoFile("bun.lock");
  const lockEntries = parseLockEntries(repoLock);
  const directNames = directDependencyNames(await readRepoFile("package.json"));

  currentTree = {
    resolvedLock: repoLock,
    info: Object.fromEntries(
      directNames.map((name) => {
        // No fallback version. A direct dependency missing from the lockfile is
        // a broken fixture, and the version this map carries is precisely what
        // decides "current" from "drifted" once freshness re-resolves. Inventing
        // one would make a scenario report a result it never established.
        const entry = lockEntries.find((candidate) => candidate.key === name);
        if (!entry) {
          throw new Error(
            `fixture cannot be built: direct dependency ${name} has no top-level ` +
              `key in bun.lock, so the registry shim has no honest version to answer with`,
          );
        }
        return [name, entry.version];
      }),
    ),
  };

  // Nothing below catches a fixture-building failure. An `mkdtemp`, `write` or
  // `chmod` that fails must fail the suite loudly: a scenario that quietly does
  // not run is indistinguishable from a scenario that passed.
  cleanRun = await runCheck(await makeShimDir({ ...CLEAN_SCANNERS, bun: currentTree }));

  findingsRun = await runCheck(
    await makeShimDir({
      // osv-scanner exits 1 when it finds something; that is a SUCCESSFUL scan.
      osv: { report: osvWithFindings(2), exit: 1 },
      // trivy reports findings without changing its status (no `--exit-code`).
      trivy: { report: trivyWithFindings(3), exit: 0 },
      bun: currentTree,
    }),
  );

  absentShimDir = await makeShimDir({
    osv: { present: false },
    trivy: { present: false },
    bun: currentTree,
  });
  absentRun = await runCheck(absentShimDir);

  abnormalRun = await runCheck(
    await makeShimDir({
      ...CLEAN_SCANNERS,
      // Dies without printing anything: the failure mode a shape-based check
      // cannot tell apart from a clean report.
      trivy: { exit: 127 },
      bun: currentTree,
    }),
  );

  precedenceRun = await runCheck(
    await makeShimDir({
      osv: { report: osvWithFindings(4), exit: 1 },
      trivy: { exit: 127 },
      bun: currentTree,
    }),
  );

  jqAbsentRun = await runCheck(
    await makeShimDir({ ...CLEAN_SCANNERS, bun: currentTree }),
    { omitHarnessTools: ["jq"] },
  );

  allRuns = [
    ["clean", cleanRun],
    ["findings", findingsRun],
    ["scanner absent", absentRun],
    ["scanner abnormal", abnormalRun],
    ["findings + errored", precedenceRun],
    ["jq absent", jqAbsentRun],
  ];
}, RUN_TIMEOUT_MS);

describe("scripts/dep-check.sh", () => {
  describe("R2.2 — the run is hermetic by construction", () => {
    it("keeps the shimmed binaries out of the harness's own PATH directory", async () => {
      // The replacement PATH is `<shim dir>:<harness bin dir>`. If the harness
      // bin dir ever grew one of these, every "absent" and "abnormal" scenario
      // would silently start driving the real tool over the network.
      const entries = await readdir(await harnessBinDir());
      for (const name of ["bun", "osv-scanner", "trivy"]) {
        expect(entries, `${name} must never be reachable except as a fixture`).not.toContain(name);
      }
    });

    it("exits with one of the three documented statuses in every scenario", () => {
      for (const [label, run] of allRuns) {
        expect(DOCUMENTED_EXIT_CODES, `${label}: ${describeRun(run)}`).toContain(run.exitCode);
      }
    });

    it("agrees with the status it reported in its own summary, in every scenario", () => {
      for (const [label, run] of allRuns) {
        expect(summaryEvent(run)?.exit_code, `${label}: ${describeRun(run)}`).toBe(run.exitCode);
      }
    });

    it("emits only JSON objects on stdout, one per line, in every scenario", () => {
      for (const [label, run] of allRuns) {
        expect(run.parseError, `${label}: ${describeRun(run)}`).toBeNull();
        const nonBlank = run.stdout.split("\n").filter((line) => line.trim() !== "");
        expect(run.events.length, `${label}: ${describeRun(run)}`).toBe(nonBlank.length);
      }
    });

    it("closes every scenario with exactly one summary, and it comes last", () => {
      for (const [label, run] of allRuns) {
        const summaries = eventsOfType(run, "summary");
        expect(summaries, `${label}: ${describeRun(run)}`).toHaveLength(1);
        expect(run.events.at(-1), `${label}: ${describeRun(run)}`).toBe(summaries[0]!);
      }
    });
  });

  describe("R3.1 — the run leaves the working tree byte-identical", () => {
    /**
     * The guard this replaces enumerated its candidates: it hashed `bun.lock` and
     * `package.json` and counted top-level `node_modules` entries. All three were
     * untouched by `bun update --dry-run`, so it certified as write-free a command
     * that had just executed the `prepare` lifecycle script and rewritten
     * `dist/index.js` — 1.11 MB, and gitignored, so `git status` said nothing
     * either. Naming the paths in advance IS the defect: the write lands on the one
     * nobody thought to name.
     *
     * So nothing is named here. A marker file is created outside the repository,
     * the filesystem clock is allowed to move past it, the check runs, and only
     * then is the whole tree swept for anything newer than the marker. `dist/` and
     * `node_modules/` stay IN scope — catching a write there is the entire point.
     * Just `.git` (noise) and `.epic` (the story framework writes there while the
     * suite runs, which would flake the guard) are pruned, and pruned with `-prune`
     * rather than `-not -path`: `-not -path './.epic/*'` still prints `./.epic`
     * itself when a write bumps that directory's own mtime.
     *
     * Scope, stated rather than implied — over-claiming is precisely how the
     * previous guard failed. It observes ONE run, the clean scenario: the branch
     * that does the most work, with both scanners completing and freshness parsing
     * a table. Every other scenario exercises a subset of that same code. And today
     * the check only queries; once freshness is computed by re-resolution (R1.2),
     * this same sweep is what proves the re-resolution stayed out of the working
     * tree, with no change to it.
     */

    /** Manifests worth hashing as well as sweeping; see the mtime note below. */
    const HASHED_PATHS = ["bun.lock", "package.json"] as const;

    /**
     * SHA-256 of each path's raw BYTES, not of its decoded text. R1.2 says
     * byte-identical, and UTF-8 decoding folds every invalid sequence onto the same
     * replacement character — a difference a string hash would report as no change.
     */
    async function hashRepoFiles(): Promise<Record<string, string>> {
      const hashes: Record<string, string> = {};
      for (const path of HASHED_PATHS) {
        const bytes = await Bun.file(join(REPO_ROOT, path)).bytes();
        hashes[path] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      }
      return hashes;
    }

    let guardedRun: CheckRun;
    let writtenPaths: string[];
    let hashesBefore: Record<string, string>;
    let hashesAfter: Record<string, string>;

    beforeAll(async () => {
      // Fixtures are built before the marker, so the guarded window contains the
      // run and nothing else.
      const shimDir = await makeShimDir({ ...CLEAN_SCANNERS, bun: currentTree });

      // The helper creates the marker outside the repository and sleeps past the
      // filesystem's mtime granularity, so "written after the marker" is
      // unambiguous even at one-second resolution. One sleep is enough; a second
      // one here would only make the suite slower.
      const marker = await createWriteMarker();

      hashesBefore = await hashRepoFiles();
      guardedRun = await runCheck(shimDir);
      hashesAfter = await hashRepoFiles();

      // No try/catch, deliberately. `pathsWrittenSince` throws when `find` exits
      // non-zero, and a guard that could not run must fail the suite rather than
      // return an empty list — an unusable guard reads exactly like a clean tree.
      writtenPaths = await pathsWrittenSince(marker);
    }, RUN_TIMEOUT_MS);

    it("ran the check to completion, so an empty sweep means something", () => {
      // A run that died before doing any work also writes nothing. Pinning the
      // status and the channels it reported is what separates "wrote nothing" from
      // "did nothing" — the green-for-the-wrong-reason failure this story closes.
      expect(guardedRun.exitCode, describeRun(guardedRun)).toBe(EXIT_CLEAN);
      expect(summaryEvent(guardedRun)?.scanners_errored, describeRun(guardedRun)).toBe(0);
      expect(freshnessEvent(guardedRun)?.status, describeRun(guardedRun)).toBe("ok");
    });

    it("modifies no path anywhere in the tree, gitignored or not", () => {
      expect(
        writtenPaths,
        `the check wrote to the working tree:\n${writtenPaths.join("\n")}`,
      ).toEqual([]);
    });

    it("leaves bun.lock and package.json byte-identical, mtime or no mtime", () => {
      // THE SWEEP'S BOUNDARY, stated plainly: it compares mtimes, so a write that
      // restores the original mtime — `touch -d`, or any copy that preserves
      // timestamps — is invisible to it. These hashes are not a duplicate of the
      // sweep, they are the part of the tree the sweep cannot speak for. Two paths
      // only, so the honest reading is: any write anywhere is caught unless it also
      // forges the mtime, and on these two manifests not even then.
      expect(hashesAfter, describeRun(guardedRun)).toEqual(hashesBefore);
    });

    it("fails loudly when the sweep itself cannot run", async () => {
      // Negative control on the guard's own failure mode. `find` exits non-zero on
      // a marker that does not exist; were that swallowed, the sweep would answer
      // with an empty list, which is indistinguishable from a clean tree.
      await expect(pathsWrittenSince(join(REPO_ROOT, "no-such-write-marker"))).rejects.toThrow(
        /the write guard could not run/,
      );
    });
  });

  describe("clean tree — both scanners ran and found nothing", () => {
    it("reports each scanner separately, with the count its report carries", () => {
      expect(scannerEvent(cleanRun, "osv-scanner"), describeRun(cleanRun)).toEqual({
        event: "scanner",
        scanner: "osv-scanner",
        status: "ok",
        vulnerabilities: 0,
      });
      expect(scannerEvent(cleanRun, "trivy"), describeRun(cleanRun)).toEqual({
        event: "scanner",
        scanner: "trivy",
        status: "ok",
        vulnerabilities: 0,
      });
    });

    it("reports freshness once, with a count and the list it describes", () => {
      const [freshness, ...rest] = eventsOfType(cleanRun, "freshness");
      expect(freshness?.status as string | undefined, describeRun(cleanRun)).toBe("ok");
      expect(rest).toHaveLength(0);
      expect(freshness?.outdated).toEqual([]);
      expect(freshness?.outdated_count).toBe(0);
    });

    it("exits clean, and only because nothing was found and nothing errored", () => {
      expect(cleanRun.exitCode, describeRun(cleanRun)).toBe(EXIT_CLEAN);

      const summary = summaryEvent(cleanRun);
      expect(summary?.vulnerabilities).toBe(0);
      expect(summary?.outdated_count).toBe(0);
      expect(summary?.scanners_errored).toBe(0);
    });

    it("keeps every human-facing word on stderr", () => {
      // A caller pipes stdout straight into jq, so the diagnostics have to leave
      // by the other channel. Asserting the stderr half matters because a later
      // change redirects `bun install`'s stdout: a regression there is invisible
      // to a stdout-only check.
      expect(cleanRun.stderr).toContain("dep-check: clean and current");
      expect(cleanRun.stdout).not.toContain("dep-check:");
    });
  });

  describe("R2.3 — a scanner absent from PATH is errored, never clean", () => {
    it("puts neither scanner in the shim directory, nor anywhere its PATH reaches", async () => {
      const entries = await readdir(absentShimDir);
      expect(entries).not.toContain("osv-scanner");
      expect(entries).not.toContain("trivy");

      // The exact PATH `runCheck` hands the script. `harnessBinDir()` is cached,
      // so this is the same directory the run above resolved against — not a
      // lookalike. Neither name resolves, whatever is installed on this machine.
      const path = `${absentShimDir}:${await harnessBinDir()}`;
      expect(Bun.which("osv-scanner", { PATH: path })).toBeNull();
      expect(Bun.which("trivy", { PATH: path })).toBeNull();
    });

    it("reports not_found_on_path for each absent scanner", () => {
      expect(scannerEvent(absentRun, "osv-scanner"), describeRun(absentRun)).toEqual({
        event: "scanner",
        scanner: "osv-scanner",
        status: "errored",
        reason: "not_found_on_path",
      });
      expect(scannerEvent(absentRun, "trivy"), describeRun(absentRun)).toEqual({
        event: "scanner",
        scanner: "trivy",
        status: "errored",
        reason: "not_found_on_path",
      });
    });

    it("counts them as errored and exits incomplete", () => {
      expect(summaryEvent(absentRun)?.scanners_errored).toBe(2);
      expect(absentRun.exitCode, describeRun(absentRun)).toBe(EXIT_INCOMPLETE);
    });

    it("says on stderr that coverage was partial", () => {
      expect(absentRun.stderr).toContain("not_found_on_path");
      expect(absentRun.stderr).toContain("the tree is NOT certified clean");
      expect(absentRun.stdout).not.toContain("certified");
    });
  });

  describe("R2.4 — a scanner that exits abnormally is errored, never clean", () => {
    it("reports the abnormal status as the reason", () => {
      expect(scannerEvent(abnormalRun, "trivy"), describeRun(abnormalRun)).toEqual({
        event: "scanner",
        scanner: "trivy",
        status: "errored",
        reason: "exit_status_127",
      });
    });

    it("still reports the scanner that did run, with its own count", () => {
      expect(scannerEvent(abnormalRun, "osv-scanner")?.status).toBe("ok");
      expect(scannerEvent(abnormalRun, "osv-scanner")?.vulnerabilities).toBe(0);
    });

    it("counts exactly the failed scanner and exits incomplete", () => {
      expect(summaryEvent(abnormalRun)?.scanners_errored).toBe(1);
      expect(abnormalRun.exitCode, describeRun(abnormalRun)).toBe(EXIT_INCOMPLETE);
    });

    it("keeps the failure diagnostic on stderr", () => {
      expect(abnormalRun.stderr).toContain("trivy: scan did not complete (exit_status_127)");
      expect(abnormalRun.stdout).not.toContain("scan did not complete");
    });
  });

  describe("findings only — a complete scan that found something", () => {
    it("sums the per-scanner counts into the summary", () => {
      expect(scannerEvent(findingsRun, "osv-scanner")?.vulnerabilities).toBe(2);
      expect(scannerEvent(findingsRun, "trivy")?.vulnerabilities).toBe(3);
      expect(summaryEvent(findingsRun)?.vulnerabilities).toBe(5);
    });

    it("reports no scanner as errored", () => {
      expect(summaryEvent(findingsRun)?.scanners_errored).toBe(0);
      expect(freshnessEvent(findingsRun)?.status).toBe("ok");
    });

    it("exits with the findings status", () => {
      expect(findingsRun.exitCode, describeRun(findingsRun)).toBe(EXIT_FINDINGS);
    });
  });

  describe("R2.5 — an incomplete scan outranks findings", () => {
    it("reports the findings AND the errored scanner in the same run", () => {
      expect(scannerEvent(precedenceRun, "osv-scanner")?.vulnerabilities).toBe(4);
      expect(scannerEvent(precedenceRun, "trivy")?.reason).toBe("exit_status_127");
      expect(summaryEvent(precedenceRun)?.vulnerabilities).toBe(4);
      expect(summaryEvent(precedenceRun)?.scanners_errored).toBe(1);
    });

    it("exits incomplete, not findings", () => {
      expect(precedenceRun.exitCode, describeRun(precedenceRun)).toBe(EXIT_INCOMPLETE);
      expect(precedenceRun.exitCode).not.toBe(EXIT_FINDINGS);
    });

    it("distinguishes itself from the run that only found things", () => {
      // Both runs carry vulnerabilities; only one of them also lost a scanner.
      // Same findings, different status — that difference IS the requirement.
      expect(summaryEvent(findingsRun)?.vulnerabilities as number).toBeGreaterThan(0);
      expect(summaryEvent(precedenceRun)?.vulnerabilities as number).toBeGreaterThan(0);
      expect(precedenceRun.exitCode).not.toBe(findingsRun.exitCode);
    });
  });

  describe("R2.1/R2.2 — jq, the report's own encoder, is missing", () => {
    it("errors every channel it can no longer encode, and nothing else", () => {
      const jqFailures = jqAbsentRun.events.filter(
        (event) => event.reason === "jq_not_found_on_path",
      );
      // One per channel the check reports on: both scanners and freshness. Fewer
      // would leave a channel silently unaccounted for.
      expect(jqFailures, describeRun(jqAbsentRun)).toHaveLength(3);
      expect(scannerEvent(jqAbsentRun, "osv-scanner")?.status).toBe("errored");
      expect(scannerEvent(jqAbsentRun, "trivy")?.status).toBe("errored");
      expect(freshnessEvent(jqAbsentRun)?.status).toBe("errored");
    });

    it("exits incomplete, having certified nothing", () => {
      expect(jqAbsentRun.exitCode, describeRun(jqAbsentRun)).toBe(EXIT_INCOMPLETE);
      expect(summaryEvent(jqAbsentRun)?.scanners_errored).toBe(2);
      expect(summaryEvent(jqAbsentRun)?.freshness_status).toBe("errored");
    });

    it("still emits the hand-written report as valid JSON lines", () => {
      // This branch cannot use jq to encode itself, so it prints literals. That
      // is exactly why it needs a test: nothing else validates those strings.
      expect(jqAbsentRun.parseError, describeRun(jqAbsentRun)).toBeNull();
      expect(jqAbsentRun.stderr).toContain("jq is required to encode the report");
    });
  });
});
