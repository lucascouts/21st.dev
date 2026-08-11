import { describe, it, expect, beforeAll } from "bun:test";

import {
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_INCOMPLETE,
  OSV_CLEAN,
  RUN_TIMEOUT_MS,
  TRIVY_CLEAN,
  describeRun,
  directDependencyNames,
  eventsOfType,
  freshnessEvent,
  makeShimDir,
  parseLockEntries,
  readRepoFile,
  runCheck,
  scannerEvent,
  summaryEvent,
  type BunFixture,
  type CheckRun,
} from "./dep-check-harness.js";
import {
  PARTIAL_SUMMARY_FRAGMENT,
  installFailingSummaryJq,
  readJqCalls,
  type JqCall,
} from "./dep-check-jq-wrapper.js";

/**
 * The summary safety net of `scripts/dep-check.sh` (story 004, R1.1-R1.4).
 *
 * The script carries a last-resort net: an EXIT trap that emits a hand-written
 * "incomplete" summary if the run ends before reporting, with a comment stating
 * it "works even if jq is what broke". It did not. `emit_summary_and_exit` set
 * `summary_emitted=1` BEFORE encoding, so a failing encode aborted the shell
 * into a trap that read the flag and returned — no summary at all, and the
 * process exiting 5, a status the header does not document. Measured
 * 2026-08-11: `EXIT=5`, `summary lines emitted: 0`.
 *
 * Contract under test:
 *
 *   - exactly one summary event per run, last (R1.3)
 *   - no partial JSON object on stdout, ever (R1.3)
 *   - a failed encode exits 2, a status the header documents (R1.2, R1.4)
 *   - the flag is set only after the encoded event has been written (R1.1)
 *
 * WHY THIS FILE SHIMS `jq`, WHICH THE HARNESS FORBIDS. The rule
 * (`dep-check-harness.ts:1-23`) is that `jq` is the harness's own dependency and
 * is never replaced. The only `jq` fixture the suite had was total absence, and
 * `main`'s preflight short-circuits on that long before the summary. The
 * exception is authorised and recorded in design.md: `dep-check-jq-wrapper.ts`
 * delegates every call to the real binary and fails one, chosen by argv content.
 *
 * A BEHAVIOUR CHANGE THIS PINS ON PURPOSE. A run that was otherwise clean but
 * could not encode its summary now exits 2 and reports `freshness_status:
 * "errored"` beside a `freshness` event that says `"ok"`. The fallback encoder
 * hard-codes those two values — it is the "the run ended before it could report"
 * path, and it cannot know what happened before it. That is correct under the
 * project's "unknown is not clean" posture, and it is asserted here so it is
 * documented rather than discovered.
 */

const CLEAN_SCANNERS = {
  osv: { report: OSV_CLEAN, exit: 0 },
  trivy: { report: TRIVY_CLEAN, exit: 0 },
} as const;

/** Statuses the header documents. Anything else is a contract break (R1.4). */
const DOCUMENTED_EXIT_CODES = [EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE];

/**
 * The `bun` fixture: a re-resolution reproducing this repository's own lockfile
 * and a registry answering with the versions already installed. Configuring it
 * is NOT optional — an omitted `spec.bun` leaves the shim writing no
 * `resolved.lock`, which reads as a FAILED re-resolution, and every scenario
 * here would then exit 2 for that reason instead of its own. Since 2 is also
 * this file's expected status, the whole file would stay green while proving
 * nothing. That is the defect class story 004 exists to close.
 */
let currentTree: BunFixture;

/** Same fixtures, real `jq`: the control that isolates the encoder as the cause. */
let normalRun: CheckRun;
/** Same fixtures, with the summary encode failing. */
let failedRun: CheckRun;
let jqCalls: JqCall[];
let realJq: string;

beforeAll(async () => {
  const repoLock = await readRepoFile("bun.lock");
  const lockEntries = parseLockEntries(repoLock);
  const directNames = directDependencyNames(await readRepoFile("package.json"));

  currentTree = {
    resolvedLock: repoLock,
    info: Object.fromEntries(
      directNames.map((name) => {
        // No fallback version: a direct dependency missing from the lockfile is a
        // broken fixture, and inventing a version would make a scenario report a
        // result it never established.
        const entry = lockEntries.find((candidate) => candidate.key === name);
        if (!entry) {
          throw new Error(
            `fixture cannot be built: direct dependency ${name} has no top-level key in bun.lock`,
          );
        }
        return [name, entry.version];
      }),
    ),
  };

  normalRun = await runCheck(await makeShimDir({ ...CLEAN_SCANNERS, bun: currentTree }));

  const failedShimDir = await makeShimDir({ ...CLEAN_SCANNERS, bun: currentTree });
  realJq = await installFailingSummaryJq(failedShimDir);
  failedRun = await runCheck(failedShimDir);
  jqCalls = await readJqCalls(failedShimDir);
}, RUN_TIMEOUT_MS);

describe("dep-check — the summary event is never lost", () => {
  describe("the fixture fails one jq call and no other", () => {
    it("refuses exactly the summary encode and delegates every other call", () => {
      // Without this, a wrapper that broke `jq` generally would produce the same
      // red for an entirely different reason, and the scenario below would be
      // measuring the preflight rather than the safety net.
      const refused = jqCalls.filter((call) => call.refused);
      const delegated = jqCalls.filter((call) => !call.refused);

      expect(jqCalls.length, `the wrapper was never invoked\n${describeRun(failedRun)}`)
        .toBeGreaterThan(0);
      expect(
        refused.map((call) => call.argv),
        `expected one refused call (the summary encode), got ${JSON.stringify(refused)}`,
      ).toHaveLength(1);
      expect(refused[0]?.argv ?? "").toContain("exit_code");
      // The scanners' counts, the freshness event and the `bun info` answers all
      // go through the real binary at `${realJq}`.
      expect(delegated.length, `nothing was delegated to ${realJq}`).toBeGreaterThanOrEqual(3);
    });

    it("left every other channel encoded by the real jq", () => {
      expect(scannerEvent(failedRun, "osv-scanner")?.status, describeRun(failedRun)).toBe("ok");
      expect(scannerEvent(failedRun, "trivy")?.status).toBe("ok");
      expect(freshnessEvent(failedRun)?.status, describeRun(failedRun)).toBe("ok");
      expect(Number.isInteger(freshnessEvent(failedRun)?.examined_count)).toBe(true);
    });

    it("changes nothing about the same run with the real jq (control)", () => {
      expect(normalRun.exitCode, describeRun(normalRun)).toBe(EXIT_CLEAN);
      expect(eventsOfType(normalRun, "summary")).toHaveLength(1);
      expect(summaryEvent(normalRun)?.exit_code).toBe(EXIT_CLEAN);
    });
  });

  describe("R1.3 — a failed encode still leaves exactly one summary", () => {
    it("emits one summary event, and it is the last line of the report", () => {
      const summaries = eventsOfType(failedRun, "summary");
      expect(summaries, `expected one summary\n${describeRun(failedRun)}`).toHaveLength(1);
      expect(failedRun.events.at(-1), describeRun(failedRun)).toBe(summaries[0]!);
    });

    it("writes no partial JSON object to stdout", () => {
      // The fixture's `jq` writes a truncated object before failing, which is
      // what a real one dying mid-write leaves behind. A fix that runs `jq`
      // bare and sets the flag afterwards lets that fragment reach stdout: the
      // run then still ends with the fallback summary, so it LOOKS fixed while
      // having broken the one-JSON-object-per-line contract. Capturing before
      // printing is what closes the window, and this is the assertion that can
      // tell the two apart.
      expect(failedRun.stdout, describeRun(failedRun)).not.toContain(PARTIAL_SUMMARY_FRAGMENT);
      expect(failedRun.parseError, describeRun(failedRun)).toBeNull();

      const nonBlank = failedRun.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(failedRun.events.length, describeRun(failedRun)).toBe(nonBlank.length);
    });

    it("keeps every human-facing word on stderr", () => {
      expect(failedRun.stdout).not.toContain("dep-check:");
      expect(failedRun.stdout).not.toContain("fixture jq:");
    });
  });

  describe("R1.2/R1.4 — the run exits with a status the header documents", () => {
    it("exits incomplete, not with the encoder's own status", () => {
      // 5 is what the defect produced: `jq`'s status, escaping through `set -e`.
      expect(DOCUMENTED_EXIT_CODES, describeRun(failedRun)).toContain(failedRun.exitCode);
      expect(failedRun.exitCode, describeRun(failedRun)).toBe(EXIT_INCOMPLETE);
    });

    it("agrees with itself: the summary reports the status the process exited with", () => {
      expect(summaryEvent(failedRun)?.exit_code, describeRun(failedRun)).toBe(failedRun.exitCode);
    });

    it("reports it through the fallback encoder, not the one that failed", () => {
      // The fallback is the only encoder that can speak here, and it hard-codes
      // "errored" — it runs on the path where nothing is known about what
      // happened. The `freshness` event above says "ok"; the difference is the
      // documented behaviour change, not an inconsistency.
      expect(summaryEvent(failedRun)?.freshness_status, describeRun(failedRun)).toBe("errored");
      expect(failedRun.stderr).toContain("the check ended before it could report");
    });
  });

  describe("R1.1 — the two encoders describe the same summary", () => {
    it("emits the same key set from the fallback as from the normal path", () => {
      // Nothing in the suite has ever compared them, so `unmatched_count` — or
      // any future field — can land in one encoder and not the other and no
      // test notices. Comparing the key sets rather than naming the keys means
      // this assertion keeps holding as the summary grows, and fails the moment
      // the two drift apart.
      const normal = summaryEvent(normalRun);
      const fallback = summaryEvent(failedRun);
      expect(normal, describeRun(normalRun)).toBeDefined();
      expect(fallback, describeRun(failedRun)).toBeDefined();

      expect(
        Object.keys(fallback ?? {}).sort(),
        "the hand-written fallback and the jq encoder describe the summary differently",
      ).toEqual(Object.keys(normal ?? {}).sort());
    });

    it("carries the totals the run had already accumulated", () => {
      // The flag is what decides whether the fallback speaks; these values are
      // what make it worth hearing. Both scanners completed with zero findings
      // before the encode failed, and the fallback reports that rather than
      // inventing a zero it did not measure.
      expect(summaryEvent(failedRun)?.vulnerabilities, describeRun(failedRun)).toBe(0);
      expect(summaryEvent(failedRun)?.scanners_errored, describeRun(failedRun)).toBe(0);
    });
  });
});
