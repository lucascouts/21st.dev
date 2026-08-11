import { describe, it, expect, beforeAll } from "bun:test";

import {
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_INCOMPLETE,
  OSV_CLEAN,
  REPO_ROOT,
  RUN_TIMEOUT_MS,
  TRIVY_CLEAN,
  bumpPatch,
  createWriteMarker,
  describeRun,
  directDependencyNames,
  freshnessEvent,
  makeShimDir,
  parseLockEntries,
  pathsWrittenSince,
  readInstallReceipt,
  readRepoFile,
  rewriteLockVersion,
  runCheck,
  summaryEvent,
  type CheckRun,
  type LockEntry,
} from "./dep-check-harness.js";

/**
 * Freshness coverage for `scripts/dep-check.sh` (story 003, R1.1-R1.5, R1.8).
 *
 * The question the check must answer is *"which packages would a re-resolution
 * move?"* — asked of the whole resolved tree, the 100 packages `bun.lock`
 * records, not of the 5 the manifest declares. Story 002 answered the second
 * question while claiming the first, and every package that motivated story 001
 * is transitive, so the detector could never see any of them.
 *
 * These scenarios therefore pin *coverage*, not shape. A test that only checks
 * `outdated` is an array and `outdated_count` matches its length passes just as
 * happily on a set drawn from the wrong population — which is exactly how the
 * defect shipped.
 *
 * Contract under test:
 *
 *   {"event":"freshness","status":"ok","examined_count":100,"outdated_count":1,
 *    "outdated":[{"name":"jose","key":"jose","scope":"transitive",
 *                 "current":"6.2.7","update":"6.2.8"}]}
 *   {"event":"freshness","status":"errored","reason":"<reason>"}
 *
 * `examined_count` is the guard against a coverage regression: it is the number
 * of packages the freshness half looked at, and it is the metric whose absence
 * made 0-of-5 indistinguishable from 0-of-100.
 */

/** Every external binary is a fixture; see dep-check-harness.ts. */
const CLEAN_SCANNERS = {
  osv: { report: OSV_CLEAN, exit: 0 },
  trivy: { report: TRIVY_CLEAN, exit: 0 },
} as const;

let repoLock: string;
let lockEntries: LockEntry[];
let directNames: string[];
/** Versions `bun info` answers for the direct dependencies: no out-of-range noise. */
let inRangeInfo: Record<string, string>;
/** A package the manifest does not declare — invisible to any manifest-scoped query. */
let transitive: LockEntry;
/**
 * How many packages the lockfile records, counted independently of the key
 * regex the check uses: every package entry carries exactly one integrity hash.
 */
let integrityCount: number;

beforeAll(async () => {
  repoLock = await readRepoFile("bun.lock");
  lockEntries = parseLockEntries(repoLock);
  directNames = directDependencyNames(await readRepoFile("package.json"));

  inRangeInfo = Object.fromEntries(
    directNames.map((name) => [
      name,
      lockEntries.find((entry) => entry.key === name)?.version ?? "0.0.0",
    ]),
  );

  integrityCount = (repoLock.match(/"sha512-/g) ?? []).length;

  const preferred = lockEntries.find((entry) => entry.key === "jose");
  const anyTransitive = lockEntries.find(
    (entry) => !directNames.includes(entry.name) && !entry.key.includes("/"),
  );
  const chosen = preferred ?? anyTransitive;
  if (!chosen) throw new Error("bun.lock records no transitive package to drift");
  transitive = chosen;
});

/** The lockfile a re-resolution would produce with exactly one package moved. */
function lockWithDrift(entry: LockEntry, to: string): string {
  return rewriteLockVersion(repoLock, entry.key, entry.version, to);
}

describe("dep-check freshness — coverage of the whole resolved tree", () => {
  describe("R1.1/R1.4 — a transitive package that moved is reported", () => {
    let run: CheckRun;
    let shimDir: string;
    let updated: string;

    beforeAll(async () => {
      updated = bumpPatch(transitive.version);
      shimDir = await makeShimDir({
        ...CLEAN_SCANNERS,
        bun: { resolvedLock: lockWithDrift(transitive, updated), info: inRangeInfo },
      });
      run = await runCheck(shimDir);
    }, RUN_TIMEOUT_MS);

    it("re-resolves in a copy outside the working tree, carrying the cooldown policy (R1.3)", async () => {
      const receipt = await readInstallReceipt(shimDir);
      expect(receipt, `no re-resolution happened\n${describeRun(run)}`).not.toBeNull();
      expect(receipt?.cwd.startsWith(REPO_ROOT)).toBe(false);
      // bunfig.toml carries install.minimumReleaseAge, so a release still inside
      // the 7-day quarantine is not offered as available.
      expect(receipt?.entries).toContain("bunfig.toml");
      expect(receipt?.entries).toContain("package.json");
    });

    it("removes the isolated copy on the way out", async () => {
      const receipt = await readInstallReceipt(shimDir);
      expect(receipt).not.toBeNull();
      expect(await Bun.file(`${receipt?.cwd}/bun.lock`).exists()).toBe(false);
    });

    it("reports the drifted package with its recorded and available versions", () => {
      const freshness = freshnessEvent(run);
      expect(freshness?.status as string | undefined, describeRun(run)).toBe("ok");

      const outdated = (freshness?.outdated ?? []) as Array<Record<string, unknown>>;
      const found = outdated.find((item) => item.key === transitive.key);

      expect(
        found,
        `expected ${transitive.key} in outdated, got ${JSON.stringify(outdated)}`,
      ).toBeDefined();
      expect(found?.name).toBe(transitive.name);
      expect(found?.current).toBe(transitive.version);
      expect(found?.update).toBe(updated);
    });

    it("marks it transitive, because its range belongs to a parent package", () => {
      const outdated = (freshnessEvent(run)?.outdated ?? []) as Array<Record<string, unknown>>;
      expect(outdated.find((item) => item.key === transitive.key)?.scope).toBe("transitive");
    });

    it("carries no `latest` field, which would cost a registry lookup per package", () => {
      const outdated = (freshnessEvent(run)?.outdated ?? []) as Array<Record<string, unknown>>;
      const found = outdated.find((item) => item.key === transitive.key);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty("latest");
    });

    it("derives outdated_count from the list it describes", () => {
      const freshness = freshnessEvent(run);
      const outdated = (freshness?.outdated ?? []) as unknown[];
      expect(freshness?.outdated_count).toBe(outdated.length);
      expect(freshness?.outdated_count).toBe(1);
    });

    it("examined every package in the lockfile, not only the declared ones", () => {
      const freshness = freshnessEvent(run);
      expect(Number.isInteger(freshness?.examined_count)).toBe(true);

      // The guard against a coverage regression: this repository declares 5
      // dependencies and resolves ~100 packages, so anything at or below the
      // declared count means the manifest-scoped question came back.
      expect(freshness?.examined_count as number).toBeGreaterThan(directNames.length);

      // Counted from the integrity markers rather than from parseLockEntries():
      // that helper uses the same `"key": ["name@version"` shape the check
      // itself parses, so it would share any blind spot in that regex and agree
      // with a wrong answer. One package, one integrity hash, no overlap.
      expect(freshness?.examined_count).toBe(integrityCount);
    });

    it("exits with the findings status and says so in the summary (R1.4)", () => {
      expect(run.exitCode, describeRun(run)).toBe(EXIT_FINDINGS);
      expect(summaryEvent(run)?.exit_code).toBe(EXIT_FINDINGS);
      expect(summaryEvent(run)?.outdated_count).toBe(1);
      expect(summaryEvent(run)?.freshness_status).toBe("ok");
    });

    it("keeps stdout one JSON object per line, despite bun printing there", () => {
      // `bun install` prints its banner on stdout. Letting that inherit would
      // corrupt the stream a caller pipes into jq.
      expect(run.parseError, describeRun(run)).toBeNull();
      expect(run.stdout).not.toContain("bun install v");
    });
  });

  describe("R1.1 — a name resolved twice is diffed per lockfile key, not per name", () => {
    let run: CheckRun;
    /** The resolution that moved. */
    let moved: LockEntry;
    /** The same package name at another key, which did NOT move. */
    let sibling: LockEntry;
    let updated: string;

    beforeAll(async () => {
      // `bun.lock` legitimately resolves one package name more than once —
      // content-type sits at the root and again under body-parser and type-is.
      // Diffing on the bare name reads that as drift and invents a finding,
      // which is the whole reason the event carries `key` as well as `name`.
      const groups = new Map<string, LockEntry[]>();
      for (const entry of lockEntries) {
        groups.set(entry.name, [...(groups.get(entry.name) ?? []), entry]);
      }
      const dual = [...groups.values()].find((group) => group.length > 1);
      if (!dual?.[0] || !dual[1]) {
        throw new Error("bun.lock records no package name resolved more than once");
      }
      [moved, sibling] = [dual[0], dual[1]];
      updated = bumpPatch(moved.version);

      run = await runCheck(
        await makeShimDir({
          ...CLEAN_SCANNERS,
          bun: { resolvedLock: lockWithDrift(moved, updated), info: inRangeInfo },
        }),
      );
    }, RUN_TIMEOUT_MS);

    it("reports the resolution that moved, identified by its key", () => {
      const outdated = (freshnessEvent(run)?.outdated ?? []) as Array<Record<string, unknown>>;
      const found = outdated.find((item) => item.key === moved.key);

      expect(
        found,
        `expected key ${moved.key} in outdated, got ${JSON.stringify(outdated)}`,
      ).toBeDefined();
      expect(found?.name).toBe(moved.name);
      expect(found?.current).toBe(moved.version);
      expect(found?.update).toBe(updated);
    });

    it("leaves the other resolution of the same name alone", () => {
      const outdated = (freshnessEvent(run)?.outdated ?? []) as Array<Record<string, unknown>>;
      expect(
        outdated.find((item) => item.key === sibling.key),
        `${sibling.key} did not move; reporting it is phantom drift`,
      ).toBeUndefined();
      expect(outdated).toHaveLength(1);
    });

    it("exits with the findings status", () => {
      expect(run.exitCode, describeRun(run)).toBe(EXIT_FINDINGS);
    });
  });

  describe("R1.2 — the re-resolution leaves the working tree byte-identical", () => {
    it("writes nothing anywhere in the repository, gitignored paths included", async () => {
      const marker = await createWriteMarker();
      const run = await runCheck(
        await makeShimDir({
          ...CLEAN_SCANNERS,
          bun: {
            resolvedLock: lockWithDrift(transitive, bumpPatch(transitive.version)),
            info: inRangeInfo,
          },
        }),
      );

      const written = await pathsWrittenSince(marker);
      expect(written, `${written.join(", ")}\n${describeRun(run)}`).toEqual([]);
    }, RUN_TIMEOUT_MS);
  });

  describe("R1.5 — an unchanged tree reports zero", () => {
    let run: CheckRun;

    beforeAll(async () => {
      run = await runCheck(
        await makeShimDir({
          ...CLEAN_SCANNERS,
          bun: { resolvedLock: repoLock, info: inRangeInfo },
        }),
      );
    }, RUN_TIMEOUT_MS);

    it("reports an empty update list and a zero count", () => {
      const freshness = freshnessEvent(run);
      expect(freshness?.status as string | undefined, describeRun(run)).toBe("ok");
      expect(freshness?.outdated).toEqual([]);
      expect(freshness?.outdated_count).toBe(0);
    });

    it("still reports how many packages it examined", () => {
      expect(freshnessEvent(run)?.examined_count).toBe(integrityCount);
    });

    it("exits clean", () => {
      expect(run.exitCode, describeRun(run)).toBe(EXIT_CLEAN);
    });
  });

  describe("R1.8 — a re-resolution that cannot complete is errored, never clean", () => {
    it("reports a reason and exits incomplete when the re-resolution fails", async () => {
      const run = await runCheck(
        await makeShimDir({
          ...CLEAN_SCANNERS,
          bun: { resolvedLock: repoLock, info: inRangeInfo, installExit: 1 },
        }),
      );

      const freshness = freshnessEvent(run);
      expect(freshness?.status as string | undefined, describeRun(run)).toBe("errored");
      expect(typeof freshness?.reason).toBe("string");
      expect(freshness?.reason as string).not.toBe("");
      // An errored freshness event carries no counts: unknown is not zero.
      expect(freshness).not.toHaveProperty("outdated_count");
      expect(run.exitCode).toBe(EXIT_INCOMPLETE);
      expect(summaryEvent(run)?.freshness_status).toBe("errored");
    }, RUN_TIMEOUT_MS);

    it("reports not_found_on_path and exits incomplete when bun is absent", async () => {
      const run = await runCheck(await makeShimDir({ ...CLEAN_SCANNERS, bun: { present: false } }));

      expect(freshnessEvent(run)?.status as string | undefined, describeRun(run)).toBe("errored");
      expect(freshnessEvent(run)?.reason).toBe("not_found_on_path");
      expect(run.exitCode).toBe(EXIT_INCOMPLETE);
    }, RUN_TIMEOUT_MS);

    it("does not leave the isolated copy behind when the re-resolution fails", async () => {
      const shimDir = await makeShimDir({
        ...CLEAN_SCANNERS,
        bun: { resolvedLock: repoLock, info: inRangeInfo, installExit: 1 },
      });
      await runCheck(shimDir);

      const receipt = await readInstallReceipt(shimDir);
      expect(receipt).not.toBeNull();
      expect(await Bun.file(`${receipt?.cwd}/bun.lock`).exists()).toBe(false);
    }, RUN_TIMEOUT_MS);
  });
});
