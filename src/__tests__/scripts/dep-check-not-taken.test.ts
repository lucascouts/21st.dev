import { describe, it, expect, beforeAll } from "bun:test";

import {
  EXIT_CLEAN,
  EXIT_INCOMPLETE,
  OSV_CLEAN,
  RUN_TIMEOUT_MS,
  TRIVY_CLEAN,
  describeRun,
  directDependencyNames,
  freshnessEvent,
  makeShimDir,
  parseLockEntries,
  readInfoQueries,
  readRepoFile,
  runCheck,
  runWithFixtures,
  summaryEvent,
  type CheckRun,
  type LockEntry,
} from "./dep-check-harness.js";

/**
 * The `not_taken` signal of `scripts/dep-check.sh` (story 003, R1.6-R1.7).
 *
 * A direct dependency can have a published release that a re-resolution would
 * not install. That is worth surfacing — it is the difference between "nothing
 * newer exists" and "something newer exists and you are not getting it" — but
 * it is not an update the tree would take, so it must not be counted toward the
 * update total and must not drive the exit status.
 *
 * R1.6 says "would not take", not "outside the declared range", and the
 * difference is load-bearing. There are two reasons a release is not taken:
 *
 *   1. the declared semver range forbids it (a major bump), and
 *   2. the range allows it, but `install.minimumReleaseAge` still quarantines it.
 *
 * The second is invisible to a range check, so a mechanism that tested the range
 * would report "in range, therefore taken" about a release the next `bun install`
 * demonstrably would not take. The check compares the newest published version
 * against what the re-resolution actually produced, which covers both — and
 * deliberately does not distinguish them, because the reader's next step is the
 * same either way.
 *
 * The signal is scoped to direct dependencies on purpose: a release not taken in
 * a transitive package is not actionable, because the range belongs to the
 * parent package, not to this repository.
 *
 * Contract under test:
 *
 *   "not_taken":[{"name":"typescript","scope":"direct",
 *                 "current":"6.0.3","latest":"7.0.2"}]
 */

const CLEAN_SCANNERS = {
  osv: { report: OSV_CLEAN, exit: 0 },
  trivy: { report: TRIVY_CLEAN, exit: 0 },
} as const;

/** A major bump is outside a caret range by definition. */
function bumpMajor(version: string): string {
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  return [String(Number.isNaN(major) ? 1 : major + 1), "0", "0"].join(".");
}

/** A minor bump is inside a caret range by definition. */
function bumpMinor(version: string): string {
  const parts = version.split(".");
  const minor = Number.parseInt(parts[1] ?? "0", 10);
  return [parts[0] ?? "0", String(Number.isNaN(minor) ? 1 : minor + 1), "0"].join(".");
}

let repoLock: string;
let lockEntries: LockEntry[];
let directNames: string[];
/** The direct dependency the scenarios publish a newer release for. */
let subject: LockEntry;

beforeAll(async () => {
  repoLock = await readRepoFile("bun.lock");
  lockEntries = parseLockEntries(repoLock);

  const manifest = await readRepoFile("package.json");
  directNames = directDependencyNames(manifest);
  const ranges = {
    ...((JSON.parse(manifest) as { dependencies?: Record<string, string> }).dependencies ?? {}),
    ...((JSON.parse(manifest) as { devDependencies?: Record<string, string> }).devDependencies ??
      {}),
  };

  const declared = lockEntries.filter((entry) => directNames.includes(entry.key));
  // A caret range is what makes the in-range scenario meaningful: a minor bump
  // is inside it, so only the quarantine can explain the release not being taken.
  const caret = declared.filter((entry) => (ranges[entry.key] ?? "").startsWith("^"));
  const chosen = caret.find((entry) => entry.key === "typescript") ?? caret[0];
  if (!chosen) throw new Error("package.json declares no caret-ranged dependency in bun.lock");
  subject = chosen;
});

/** `bun info` answers: every direct dependency at its recorded version, bar one. */
function infoWith(name: string, latest: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const declared of directNames) {
    answers[declared] =
      lockEntries.find((entry) => entry.key === declared)?.version ?? "0.0.0";
  }
  answers[name] = latest;
  return answers;
}

describe("dep-check freshness — releases the re-resolution would not take", () => {
  describe("R1.6 — a release the declared range forbids", () => {
    let run: CheckRun;
    let latest: string;

    beforeAll(async () => {
      latest = bumpMajor(subject.version);
      run = await runWithFixtures({
        ...CLEAN_SCANNERS,
        // The re-resolution moves nothing: the only news is a release it refuses.
        bun: { resolvedLock: repoLock, info: infoWith(subject.key, latest) },
      });
    }, RUN_TIMEOUT_MS);

    it("reports it with its current and its newest version", () => {
      const freshness = freshnessEvent(run);
      expect(freshness?.status as string | undefined, describeRun(run)).toBe("ok");

      const notTaken = (freshness?.not_taken ?? []) as Array<Record<string, unknown>>;
      const found = notTaken.find((item) => item.name === subject.name);

      expect(
        found,
        `expected ${subject.name} in not_taken, got ${JSON.stringify(notTaken)}`,
      ).toBeDefined();
      expect(found?.current).toBe(subject.version);
      expect(found?.latest).toBe(latest);
      expect(found?.scope).toBe("direct");
      // `update` equals `current` by definition here — that is the selection
      // criterion, so carrying it would say nothing.
      expect(found).not.toHaveProperty("update");
    });

    it("excludes it from the update count", () => {
      expect(freshnessEvent(run)?.outdated).toEqual([]);
      expect(freshnessEvent(run)?.outdated_count).toBe(0);
      expect(summaryEvent(run)?.outdated_count).toBe(0);
    });

    it("does not turn a clean tree into a finding", () => {
      expect(run.exitCode, describeRun(run)).toBe(EXIT_CLEAN);
    });
  });

  describe("R1.6 — a release the range allows but the cooldown withholds", () => {
    let run: CheckRun;
    let latest: string;

    beforeAll(async () => {
      // Inside the caret range, newer than what is recorded, and still not
      // taken — because `install.minimumReleaseAge` quarantines it for 7 days.
      // A range check would call this one "available" and say nothing; only
      // comparing against what the re-resolution actually produced catches it.
      latest = bumpMinor(subject.version);
      run = await runWithFixtures({
        ...CLEAN_SCANNERS,
        bun: { resolvedLock: repoLock, info: infoWith(subject.key, latest) },
      });
    }, RUN_TIMEOUT_MS);

    it("reports it, even though the declared range would allow it", () => {
      const freshness = freshnessEvent(run);
      expect(freshness?.status as string | undefined, describeRun(run)).toBe("ok");

      const notTaken = (freshness?.not_taken ?? []) as Array<Record<string, unknown>>;
      const found = notTaken.find((item) => item.name === subject.name);

      expect(
        found,
        `expected the quarantined ${subject.name}@${latest} in not_taken, ` +
          `got ${JSON.stringify(notTaken)}`,
      ).toBeDefined();
      expect(found?.current).toBe(subject.version);
      expect(found?.latest).toBe(latest);
      expect(found?.scope).toBe("direct");
    });

    it("still excludes it from the update count and the exit status", () => {
      expect(freshnessEvent(run)?.outdated_count).toBe(0);
      expect(run.exitCode, describeRun(run)).toBe(EXIT_CLEAN);
    });
  });

  describe("the signal is scoped to what this repository declares", () => {
    let run: CheckRun;
    let queried: string[];

    beforeAll(async () => {
      const shimDir = await makeShimDir({
        ...CLEAN_SCANNERS,
        bun: {
          resolvedLock: repoLock,
          info: infoWith(subject.key, bumpMajor(subject.version)),
        },
      });
      run = await runCheck(shimDir);
      queried = await readInfoQueries(shimDir);
    }, RUN_TIMEOUT_MS);

    it("asks the registry about the declared dependencies and nothing else", () => {
      // ~100 lookups for a signal nobody can act on is the cost this scoping
      // avoids; without the query log, an implementation that pays it looks
      // identical to one that does not.
      expect([...new Set(queried)].sort()).toEqual([...directNames].sort());
    });

    it("reports nothing it was not asked to report", () => {
      const notTaken = (freshnessEvent(run)?.not_taken ?? []) as Array<Record<string, unknown>>;
      const foreign = notTaken.filter((item) => !directNames.includes(item.name as string));
      expect(foreign).toEqual([]);
      expect(notTaken.map((item) => item.name)).toEqual([subject.name]);
    });
  });

  describe("R1.7 — an unreadable source is errored, not guessed", () => {
    it("errors when the version source answers in an unexpected shape", async () => {
      // `bun info <pkg> version --json` prints a bare quoted string. An object
      // is what a naive reader assumes, and reading it wrongly is exactly the
      // failure a formatted-output parser makes silently.
      const run = await runWithFixtures({
        ...CLEAN_SCANNERS,
        bun: {
          resolvedLock: repoLock,
          info: infoWith(subject.key, bumpMajor(subject.version)),
          infoMode: "object",
        },
      });

      expect(freshnessEvent(run)?.status as string | undefined, describeRun(run)).toBe("errored");
      expect(typeof freshnessEvent(run)?.reason).toBe("string");
      expect(run.exitCode).toBe(EXIT_INCOMPLETE);
      expect(summaryEvent(run)?.freshness_status).toBe("errored");
    }, RUN_TIMEOUT_MS);

    it("errors when the version source cannot be reached at all", async () => {
      const run = await runWithFixtures({
        ...CLEAN_SCANNERS,
        bun: {
          resolvedLock: repoLock,
          info: infoWith(subject.key, bumpMajor(subject.version)),
          infoMode: "fail",
        },
      });

      expect(freshnessEvent(run)?.status as string | undefined, describeRun(run)).toBe("errored");
      expect(freshnessEvent(run)).not.toHaveProperty("not_taken");
      expect(run.exitCode).toBe(EXIT_INCOMPLETE);
    }, RUN_TIMEOUT_MS);
  });
});
