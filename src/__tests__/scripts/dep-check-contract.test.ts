import { describe, it, expect, beforeAll } from "bun:test";

import { readRepoFile } from "./dep-check-harness.js";

/**
 * The documented contract of `scripts/dep-check.sh` (story 003, R1.1, R1.8).
 *
 * This story exists because a description and a mechanism drifted apart and
 * nothing noticed: the header promised "what a re-resolution would produce"
 * while the code asked a question scoped to the manifest, and `bunfig.toml`
 * described a re-resolution that never happened. Prose that nobody can check is
 * how that survives a review.
 *
 * So these assertions are deliberately few and deliberately tolerant. They pin
 * the claims that were wrong — the mechanism, the shape of the event, the exit
 * statuses — and nothing about wording.
 */

let script: string;
/** The leading comment block: everything before the first line of code. */
let header: string;

beforeAll(async () => {
  script = await readRepoFile("scripts/dep-check.sh");
  const lines: string[] = [];
  for (const line of script.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") lines.push(line);
    else if (lines.length > 0) break;
  }
  header = lines.join("\n");
});

describe("dep-check documents the mechanism it actually uses", () => {
  it("no longer derives freshness from a manifest-scoped query (R1.1)", () => {
    // `bun outdated` walks package.json, so it can only ever see the 5 declared
    // dependencies out of the ~100 the lockfile records. It is also the only
    // formatted-table input the script ever had: removing it removes both
    // problems at once.
    expect(script).not.toContain("bun outdated");
  });

  it("says the re-resolution happens in an isolated copy", () => {
    expect(header).toMatch(/re-resol(ution|ve|ved|ving)/i);
    expect(header).toMatch(/isolated|temporary (copy|directory)/i);
  });

  it("says the repository is left untouched by it", () => {
    expect(header).toMatch(/never touched|untouched|unchanged|byte-identical|writes nothing/i);
  });

  it("shows the freshness event it now emits, examined_count included", () => {
    // `examined_count` is the number of rows read from the recorded lockfile.
    // A report that says how much it read is what stops "found nothing" from
    // being read as "there is nothing", whatever it managed to look at.
    // What the field MEANS is pinned in `dep-check-field-contract.test.ts`
    // (story 004, R3.2); all this asserts is that the header shows it at all.
    expect(header).toContain("examined_count");
  });

  it("documents all three exit statuses and their precedence (R1.8)", () => {
    expect(header).toMatch(/^#\s+0\s+.*clean/im);
    expect(header).toMatch(/^#\s+1\s+.*(vulnerab|update|finding)/im);
    expect(header).toMatch(/^#\s+2\s+.*(errored|incomplete|partial)/im);
    expect(header).toMatch(/precedence/i);
  });

  it("warns that a run without network cannot report clean (R1.8)", () => {
    // The re-resolution needs the registry. Offline, freshness is errored and
    // the check exits incomplete — unknown is not clean, and a reader must not
    // have to discover that from a failing run.
    expect(header).toMatch(/offline/i);
  });
});
