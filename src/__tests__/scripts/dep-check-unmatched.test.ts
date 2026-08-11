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
  freshnessEvent,
  makeShimDir,
  parseLockEntries,
  readRepoFile,
  runCheck,
  summaryEvent,
  type BunFixture,
  type CheckRun,
  type LockEntry,
} from "./dep-check-harness.js";
import { addLockRow, removeLockRow } from "./dep-check-lock-keysets.js";
import { installFailingSummaryJq } from "./dep-check-jq-wrapper.js";

/**
 * The lockfile diff covers BOTH key sets (story 004, R2.1-R2.6, R3.1, R3.3).
 *
 * The diff was a comprehension over the recorded lockfile's rows, consulting the
 * re-resolved one only as a lookup table. A key the re-resolution produces and
 * `bun.lock` lacks was therefore never visited: the check reported
 * `outdated_count: 0`, `status: "ok"` and exited 0 over two lockfiles that
 * disagreed structurally. That is story 003's defect in a different population —
 * a guard reporting success over a narrower set than the one it claims.
 *
 * Every fixture in the suite agreed on its key sets until this file, because
 * `rewriteLockVersion` is the only mutator the harness has and it rewrites a
 * version in place. With equal key sets `examined_count == compared_count`
 * always, so the coverage oracle keeps passing whichever of the two the field
 * means. `dep-check-lock-keysets.ts` is what makes them differ.
 *
 * Contract under test:
 *
 *   {"event":"freshness","status":"ok","examined_count":100,"compared_count":99,
 *    "outdated_count":0,"outdated":[],
 *    "unmatched":[{"key":"body-parser/content-type","name":"content-type",
 *                  "direction":"recorded_only","recorded":"2.0.0"}],
 *    "not_taken":[]}
 *   {"event":"summary","exit_code":1,...,"unmatched_count":1}
 *
 * WHAT THIS FILE CANNOT EXPRESS, stated rather than implied. The real-world
 * shape of a `resolved_only` key is a dependency added to `package.json` without
 * regenerating `bun.lock`. The harness cannot build that: the recorded side of
 * every fixture is the repository's own `bun.lock`, and `package.json` may not
 * be edited — the write guard would catch it and R1.2 forbids it. So the
 * scenario below adds a synthetic key to the RE-RESOLVED lockfile, which
 * produces the same key-set difference by a different route. The check's
 * behaviour on that difference is what is under test; the route that creates it
 * in the wild is not covered here.
 */

const CLEAN_SCANNERS = {
  osv: { report: OSV_CLEAN, exit: 0 },
  trivy: { report: TRIVY_CLEAN, exit: 0 },
} as const;

/** A key no lockfile in this repository records, and no manifest declares. */
const SYNTHETIC: LockEntry = {
  key: "dep-check-fixture-only",
  name: "dep-check-fixture-only",
  version: "9.9.9",
};

let repoLock: string;
let lockEntries: LockEntry[];
let directNames: string[];
/**
 * Rows the recorded lockfile holds, counted from the integrity markers rather
 * than from the row regex the check itself mirrors — a count taken with the same
 * parser would share any blind spot in it and agree with a wrong answer.
 */
let integrityCount: number;

/** A nested resolution whose package name also resolves at another key. */
let nested: LockEntry;
/** That other resolution: same name, different key, and it must stay unreported. */
let sibling: LockEntry;

/**
 * The `bun` fixture is configured in EVERY scenario, deliberately. An omitted
 * `spec.bun` leaves the shim writing no `resolved.lock`, which the check reads
 * as a failed re-resolution: freshness errors and the run exits 2 for that
 * reason instead of its own. Two scenarios here expect 2 and would stay green
 * while proving nothing — the green-for-the-wrong-reason failure story 004
 * exists to close.
 */
function treeThatResolvesTo(resolvedLock: string): BunFixture {
  return { resolvedLock, info: inRangeInfo };
}

/** `bun info` answers: every declared dependency at the version already recorded. */
let inRangeInfo: Record<string, string>;

/** A key present only in the re-resolved lockfile. */
let resolvedOnlyRun: CheckRun;
/** A key present only in the recorded lockfile. */
let recordedOnlyRun: CheckRun;
/** One of each, so read and compared are provably different numbers. */
let bothRun: CheckRun;
/** One of each, plus a scanner that died: precedence in the other direction. */
let precedenceRun: CheckRun;
/** An unmatched key whose summary cannot be encoded: the fallback must account for it. */
let fallbackRun: CheckRun;
/** Identical key sets: the control proving the addition invents no finding. */
let currentRun: CheckRun;
/** A re-resolution that failed: the errored event must carry none of the new fields. */
let erroredRun: CheckRun;

let allRuns: Array<[string, CheckRun]>;

beforeAll(async () => {
  repoLock = await readRepoFile("bun.lock");
  lockEntries = parseLockEntries(repoLock);
  directNames = directDependencyNames(await readRepoFile("package.json"));
  integrityCount = (repoLock.match(/"sha512-/g) ?? []).length;

  inRangeInfo = Object.fromEntries(
    directNames.map((name) => {
      const entry = lockEntries.find((candidate) => candidate.key === name);
      if (!entry) {
        throw new Error(
          `fixture cannot be built: direct dependency ${name} has no top-level key in bun.lock`,
        );
      }
      return [name, entry.version];
    }),
  );

  // `content-type` resolves at the root and again under `body-parser` and
  // `type-is`. Removing ONE of those resolutions is what separates a diff keyed
  // on the lockfile key from one keyed on the package name: the latter reports
  // the name as still present and misses the difference entirely.
  const byName = new Map<string, LockEntry[]>();
  for (const entry of lockEntries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }
  const chosen = lockEntries.find(
    (entry) => entry.key.includes("/") && (byName.get(entry.name)?.length ?? 0) > 1,
  );
  const other = chosen
    ? byName.get(chosen.name)?.find((entry) => entry.key !== chosen.key)
    : undefined;
  if (!chosen || !other) {
    throw new Error("bun.lock records no nested resolution of a name that resolves twice");
  }
  nested = chosen;
  sibling = other;

  if (lockEntries.some((entry) => entry.key === SYNTHETIC.key || entry.name === SYNTHETIC.name)) {
    throw new Error(`bun.lock already records ${SYNTHETIC.key}; the fixture key must be synthetic`);
  }

  const resolvedOnlyLock = addLockRow(repoLock, SYNTHETIC);
  const recordedOnlyLock = removeLockRow(repoLock, nested.key);
  const bothLock = addLockRow(recordedOnlyLock, SYNTHETIC);

  resolvedOnlyRun = await runCheck(
    await makeShimDir({ ...CLEAN_SCANNERS, bun: treeThatResolvesTo(resolvedOnlyLock) }),
  );
  recordedOnlyRun = await runCheck(
    await makeShimDir({ ...CLEAN_SCANNERS, bun: treeThatResolvesTo(recordedOnlyLock) }),
  );
  bothRun = await runCheck(
    await makeShimDir({ ...CLEAN_SCANNERS, bun: treeThatResolvesTo(bothLock) }),
  );
  precedenceRun = await runCheck(
    await makeShimDir({
      ...CLEAN_SCANNERS,
      // Dies without printing: the scanner failure that must outrank findings.
      trivy: { exit: 127 },
      bun: treeThatResolvesTo(bothLock),
    }),
  );

  const fallbackShimDir = await makeShimDir({
    ...CLEAN_SCANNERS,
    bun: treeThatResolvesTo(resolvedOnlyLock),
  });
  await installFailingSummaryJq(fallbackShimDir);
  fallbackRun = await runCheck(fallbackShimDir);

  currentRun = await runCheck(
    await makeShimDir({ ...CLEAN_SCANNERS, bun: treeThatResolvesTo(repoLock) }),
  );
  erroredRun = await runCheck(
    await makeShimDir({
      ...CLEAN_SCANNERS,
      bun: { resolvedLock: repoLock, info: inRangeInfo, installExit: 1 },
    }),
  );

  allRuns = [
    ["resolved_only", resolvedOnlyRun],
    ["recorded_only", recordedOnlyRun],
    ["both directions", bothRun],
    ["unmatched + errored scanner", precedenceRun],
    ["unmatched + failed summary encode", fallbackRun],
    ["identical key sets", currentRun],
    ["errored freshness", erroredRun],
  ];
}, RUN_TIMEOUT_MS);

/** The `unmatched` array of a run, or an empty one when the field is absent. */
function unmatchedOf(run: CheckRun): Array<Record<string, unknown>> {
  return (freshnessEvent(run)?.unmatched ?? []) as Array<Record<string, unknown>>;
}

describe("dep-check freshness — keys present in only one lockfile", () => {
  describe("R2.1/R2.2/R2.3 — a key only the re-resolution produced", () => {
    it("reports it, with the direction it is missing in", () => {
      const freshness = freshnessEvent(resolvedOnlyRun);
      expect(freshness?.status as string | undefined, describeRun(resolvedOnlyRun)).toBe("ok");

      const found = unmatchedOf(resolvedOnlyRun).find((item) => item.key === SYNTHETIC.key);
      expect(
        found,
        `expected ${SYNTHETIC.key} in unmatched, got ${JSON.stringify(unmatchedOf(resolvedOnlyRun))}` +
          `\n${describeRun(resolvedOnlyRun)}`,
      ).toBeDefined();
      expect(found?.name).toBe(SYNTHETIC.name);
      expect(found?.direction).toBe("resolved_only");
    });

    it("carries the version the lockfile that holds it recorded", () => {
      const found = unmatchedOf(resolvedOnlyRun).find((item) => item.key === SYNTHETIC.key);
      expect(found?.resolved).toBe(SYNTHETIC.version);
    });

    it("omits the missing version rather than nulling it", () => {
      // The precedent is `latest`, removed from `outdated` on the grounds that a
      // permanently-null field invites wrong consumption: a reader who sees
      // `"recorded": null` has to know that null means absent rather than
      // "recorded as null".
      const found = unmatchedOf(resolvedOnlyRun).find((item) => item.key === SYNTHETIC.key);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty("recorded");
    });

    it("carries no scope, because the word would mean something different here", () => {
      // For a recorded key, "direct" means "you own this constraint". For a key
      // that exists only in the re-resolved tree it would mean "you declared it
      // and your lockfile lacks it" — a different fact under an identical name,
      // which is the substitution this story exists to stop. `direction` carries
      // what matters.
      const found = unmatchedOf(resolvedOnlyRun).find((item) => item.key === SYNTHETIC.key);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty("scope");
    });

    it("keeps it out of the update list and the update count", () => {
      // `outdated` means "a version moved". An unmatched key has no version to
      // move from, so counting it there would redefine the field.
      expect(freshnessEvent(resolvedOnlyRun)?.outdated, describeRun(resolvedOnlyRun)).toEqual([]);
      expect(freshnessEvent(resolvedOnlyRun)?.outdated_count).toBe(0);
      expect(summaryEvent(resolvedOnlyRun)?.outdated_count).toBe(0);
    });
  });

  describe("R2.1/R2.2/R2.3 — a key only the recorded lockfile holds", () => {
    it("reports it, with the direction and the recorded version", () => {
      const freshness = freshnessEvent(recordedOnlyRun);
      expect(freshness?.status as string | undefined, describeRun(recordedOnlyRun)).toBe("ok");

      const found = unmatchedOf(recordedOnlyRun).find((item) => item.key === nested.key);
      expect(
        found,
        `expected ${nested.key} in unmatched, got ${JSON.stringify(unmatchedOf(recordedOnlyRun))}` +
          `\n${describeRun(recordedOnlyRun)}`,
      ).toBeDefined();
      expect(found?.name).toBe(nested.name);
      expect(found?.direction).toBe("recorded_only");
      expect(found?.recorded).toBe(nested.version);
    });

    it("omits `resolved` and carries no scope", () => {
      const found = unmatchedOf(recordedOnlyRun).find((item) => item.key === nested.key);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty("resolved");
      expect(found).not.toHaveProperty("scope");
    });

    it("is keyed on the lockfile key, so the same name at another key is untouched", () => {
      // `${sibling.key}` resolves the same package name and did not move. A diff
      // keyed on the name sees the name still present in both lockfiles and
      // reports nothing at all; one keyed on the name in the other direction
      // would report this sibling as missing too. Neither happened.
      const unmatched = unmatchedOf(recordedOnlyRun);
      expect(
        unmatched.find((item) => item.key === sibling.key),
        `${sibling.key} is present in both lockfiles; reporting it is phantom drift`,
      ).toBeUndefined();
      expect(unmatched, describeRun(recordedOnlyRun)).toHaveLength(1);
      expect(freshnessEvent(recordedOnlyRun)?.outdated).toEqual([]);
    });
  });

  describe("R3.1/R3.3 — rows read and keys compared are different numbers", () => {
    it("still reports every row read from the recorded lockfile", () => {
      // Unchanged in value, and deliberately so: renaming it would break the
      // header contract and four assertions for no behavioural gain.
      expect(freshnessEvent(bothRun)?.examined_count, describeRun(bothRun)).toBe(integrityCount);
      expect(freshnessEvent(recordedOnlyRun)?.examined_count).toBe(integrityCount);
    });

    it("reports how many keys were present in both, and it is the smaller number", () => {
      // THE ASSERTION NO ALIASING IMPLEMENTATION PASSES. Every fixture before
      // this story had identical key sets, so `compared_count: ($recorded |
      // length)` would satisfy all of them. Here one recorded key has no
      // counterpart, so the two must diverge by exactly one.
      const freshness = freshnessEvent(bothRun);
      expect(freshness?.compared_count, describeRun(bothRun)).toBe(integrityCount - 1);
      expect(freshness?.compared_count).not.toBe(freshness?.examined_count);
    });

    it("satisfies the invariant: read minus compared is the recorded-only count", () => {
      const freshness = freshnessEvent(bothRun);
      const recordedOnly = unmatchedOf(bothRun).filter(
        (item) => item.direction === "recorded_only",
      );
      expect(unmatchedOf(bothRun), describeRun(bothRun)).toHaveLength(2);
      expect(
        (freshness?.examined_count as number) - (freshness?.compared_count as number),
        `examined_count - compared_count must equal the number of recorded_only keys ` +
          `(${recordedOnly.length})\n${describeRun(bothRun)}`,
      ).toBe(recordedOnly.length);
    });

    it("counts a resolved-only key as neither read nor compared", () => {
      // The mirror of the assertion above: a key the recorded lockfile never had
      // cannot change either number, so an implementation that derives
      // `compared_count` by subtracting the whole `unmatched` array fails here.
      const freshness = freshnessEvent(resolvedOnlyRun);
      expect(freshness?.examined_count, describeRun(resolvedOnlyRun)).toBe(integrityCount);
      expect(freshness?.compared_count, describeRun(resolvedOnlyRun)).toBe(integrityCount);
      expect(unmatchedOf(resolvedOnlyRun)).toHaveLength(1);
    });
  });

  describe("R2.4 — an unmatched key drives the findings status, never the incomplete one", () => {
    it("exits 1 when the scanners are clean and nothing else went wrong", () => {
      // The single most likely implementation error is extending the INCOMPLETE
      // branch instead of the findings branch, and no existing test can see it:
      // the suite's precedence scenario already expects 2 and stays green either
      // way. This is the scenario that tells them apart.
      expect(resolvedOnlyRun.exitCode, describeRun(resolvedOnlyRun)).toBe(EXIT_FINDINGS);
      expect(resolvedOnlyRun.exitCode).not.toBe(EXIT_INCOMPLETE);
      expect(recordedOnlyRun.exitCode, describeRun(recordedOnlyRun)).toBe(EXIT_FINDINGS);
    });

    it("leaves the unmatched key as the only thing that can explain that exit", () => {
      // Without this, an exit 1 produced by some unrelated finding would satisfy
      // the assertion above.
      const summary = summaryEvent(resolvedOnlyRun);
      expect(summary?.exit_code, describeRun(resolvedOnlyRun)).toBe(EXIT_FINDINGS);
      expect(summary?.vulnerabilities).toBe(0);
      expect(summary?.outdated_count).toBe(0);
      expect(summary?.scanners_errored).toBe(0);
      expect(summary?.freshness_status).toBe("ok");
    });

    it("still exits 2 when a scanner errored alongside it", () => {
      // Precedence asserted in the direction that did NOT already work: findings
      // must not start outranking incomplete now that a second driver feeds it.
      expect(precedenceRun.exitCode, describeRun(precedenceRun)).toBe(EXIT_INCOMPLETE);
      expect(summaryEvent(precedenceRun)?.scanners_errored).toBe(1);
      expect(summaryEvent(precedenceRun)?.unmatched_count).toBe(2);
    });
  });

  describe("R2.5/R2.6 — the summary accounts for the exit status on its own", () => {
    it("reports the count in the summary, derived from the array it describes", () => {
      // A reader of the summary line alone must be able to tell why the run
      // failed. Without this field the line reads `vulnerabilities: 0,
      // outdated_count: 0, freshness_status: "ok"` beside exit 1 — nothing
      // accounting for the failure.
      for (const [label, run] of [
        ["resolved_only", resolvedOnlyRun],
        ["recorded_only", recordedOnlyRun],
        ["both directions", bothRun],
      ] as Array<[string, CheckRun]>) {
        expect(summaryEvent(run)?.unmatched_count, `${label}: ${describeRun(run)}`).toBe(
          unmatchedOf(run).length,
        );
      }
      expect(summaryEvent(bothRun)?.unmatched_count, describeRun(bothRun)).toBe(2);
    });

    it("reports it from the hand-written fallback encoder too", () => {
      // The two encoders are independent — one is `jq`, one is a `printf` of
      // pre-validated integers — and nothing has ever compared them, so a field
      // can land in one and not the other in silence. Here the summary encode
      // fails while an unmatched key is outstanding, so the fallback is the only
      // encoder that speaks, and it must still account for it.
      expect(fallbackRun.exitCode, describeRun(fallbackRun)).toBe(EXIT_INCOMPLETE);
      expect(summaryEvent(fallbackRun)?.unmatched_count, describeRun(fallbackRun)).toBe(1);
    });

    it("describes the summary with the same keys through either encoder", () => {
      const normal = summaryEvent(resolvedOnlyRun);
      const fallback = summaryEvent(fallbackRun);
      expect(normal, describeRun(resolvedOnlyRun)).toBeDefined();
      expect(fallback, describeRun(fallbackRun)).toBeDefined();
      expect(
        Object.keys(fallback ?? {}).sort(),
        "the hand-written fallback and the jq encoder describe the summary differently",
      ).toEqual(Object.keys(normal ?? {}).sort());
    });
  });

  describe("regression — the new field manufactures nothing", () => {
    it("reports an empty list and a zero count when the key sets agree", () => {
      // This repository's two lockfiles carry the same 100 keys, measured
      // 2026-08-11, so the addition must be invisible here: same exit, same
      // counts, an empty `unmatched`.
      const freshness = freshnessEvent(currentRun);
      expect(freshness?.status as string | undefined, describeRun(currentRun)).toBe("ok");
      expect(freshness?.unmatched, describeRun(currentRun)).toEqual([]);
      expect(freshness?.compared_count).toBe(freshness?.examined_count);
      expect(summaryEvent(currentRun)?.unmatched_count).toBe(0);
      expect(currentRun.exitCode, describeRun(currentRun)).toBe(EXIT_CLEAN);
    });

    it("keeps the errored freshness event free of counts, new ones included", () => {
      // An absent count must never be read as a zero count, so the new fields
      // belong to the ok-path object only.
      const freshness = freshnessEvent(erroredRun);
      expect(freshness?.status as string | undefined, describeRun(erroredRun)).toBe("errored");
      expect(freshness).not.toHaveProperty("examined_count");
      expect(freshness).not.toHaveProperty("compared_count");
      expect(freshness).not.toHaveProperty("outdated_count");
      expect(freshness).not.toHaveProperty("unmatched");
      expect(erroredRun.exitCode, describeRun(erroredRun)).toBe(EXIT_INCOMPLETE);
    });

    it("keeps stdout one JSON object per line, and one summary last, everywhere", () => {
      for (const [label, run] of allRuns) {
        expect(run.parseError, `${label}: ${describeRun(run)}`).toBeNull();
        const summaries = run.events.filter((event) => event.event === "summary");
        expect(summaries, `${label}: ${describeRun(run)}`).toHaveLength(1);
        expect(run.events.at(-1), `${label}: ${describeRun(run)}`).toBe(summaries[0]!);
        expect([EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE], `${label}: ${describeRun(run)}`)
          .toContain(run.exitCode);
      }
    });
  });
});
