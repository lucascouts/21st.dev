import { describe, it, expect, beforeAll } from "bun:test";

import { readRepoFile } from "./dep-check-harness.js";

/**
 * The operational record around `scripts/dep-check.sh` (story 003, R4.1, R5.1).
 *
 * The check has two reporting channels: the JSON it prints, and the exit status
 * the scheduler reads. Declaring the findings status successful mutes the second
 * one — a week with an available update looks exactly like a clean week in
 * `systemctl --user status`, which is half the mechanism silently switched off.
 *
 * The `bunfig.toml` comment is the same class of defect one level down: a
 * description of a mechanism that did not exist.
 */

/**
 * Numeric components of a version-ish string, in order: `>=1.3.0` -> [1, 3, 0],
 * `1.3-alpine` -> [1, 3]. An empty result means "no version here", which the
 * floor assertion below treats as a failure rather than as a pass.
 */
function versionComponents(text: string): number[] {
  const found = text.match(/(\d+(?:\.\d+)*)/);
  return found ? found[1].split(".").map(Number) : [];
}

/**
 * Component-wise `>=`, compared over only as many components as the SHORTER of
 * the two supplies. `1.3-alpine` carries two components, not three, so a
 * comparison demanding major.minor.patch would reject today's correct tag.
 * [1,3] against a floor of [1,3,0] is satisfied; [1,2] is not; [1,4] is.
 */
function atLeast(got: number[], floor: number[]): boolean {
  for (let i = 0; i < Math.min(got.length, floor.length); i += 1) {
    if (got[i] > floor[i]) return true;
    if (got[i] < floor[i]) return false;
  }
  return true;
}

let unit: string;
let readme: string;
let bunfig: string;
/**
 * `bunfig.toml` is prose hard-wrapped near 78 columns, so any phrase in it can
 * land across a line break and a comment marker. Matching the flattened text
 * asserts what the comment says rather than how it happens to be wrapped.
 */
let bunfigFlat: string;

beforeAll(async () => {
  unit = await readRepoFile("contrib/systemd/dep-check.service");
  readme = await readRepoFile("contrib/systemd/README.md");
  bunfig = await readRepoFile("bunfig.toml");
  bunfigFlat = bunfig.replace(/\n\s*#?\s*/g, " ").replace(/\s+/g, " ");
});

describe("the systemd unit reports findings honestly (R4.1)", () => {
  it("declares no exit status successful beyond the clean one", () => {
    // With SuccessExitStatus=1 a findings run reports success and never appears
    // in `systemctl --user --failed`, so nothing draws the eye to it.
    expect(unit).not.toMatch(/^\s*SuccessExitStatus\s*=/m);
  });

  it("still runs the same check through the same entry point", () => {
    expect(unit).toMatch(/^ExecStart=bash scripts\/dep-check\.sh$/m);
    expect(unit).toMatch(/^Type=oneshot$/m);
  });

  it("still binds the repository path at install time, not in the file", () => {
    // A unit that hard-codes one machine's home directory is wrong everywhere
    // else; %h plus a drop-in is what keeps it portable.
    expect(unit).toContain("%h");
    expect(unit).not.toMatch(/\/home\/|\/Users\//);
  });

  it("still requires an explicit installation step", () => {
    // No [Install] section means `systemctl --user enable` on the SERVICE is a
    // no-op: the unit exists only because the timer pulls it, and installing is
    // an act someone has to perform. story.md claims this under Unchanged
    // Behavior and nothing asserted it until now.
    expect(unit).not.toMatch(/^\s*\[Install\]\s*$/m);
  });

  it("is documented as failing on findings", () => {
    expect(readme).not.toContain("SuccessExitStatus");
    const row = readme
      .split("\n")
      .find((line) => /^\|\s*1\s*\|/.test(line));
    expect(row, "the exit-code table has no row for exit 1").toBeDefined();
    expect(row).toMatch(/failed/i);
    expect(row).not.toMatch(/success/i);
  });
});

describe("the configuration comment matches the mechanism (R5.1)", () => {
  it("says the re-resolution happens in an isolated copy", () => {
    expect(bunfigFlat).toMatch(/isolated copy/i);
  });

  it("says the repository lockfile is left unchanged by it", () => {
    expect(bunfigFlat).toMatch(/(lockfile|working tree)[^.]{0,80}(unchanged|untouched)/i);
  });

  it("no longer claims the check re-resolves the tree in place", () => {
    expect(bunfigFlat).not.toMatch(/re-resolves and scans the tree/i);
  });

  it("still explains the cooldown it configures", () => {
    expect(bunfig).toMatch(/^minimumReleaseAge\s*=\s*604800$/m);
    expect(bunfig).toMatch(/quarantine/i);
  });
});

/**
 * Two claims story.md makes under Unchanged Behavior that, until this file, were
 * attributed to bare commands appearing in no Validation line and no quality
 * gate. A claim with no executor is how story 002's coverage gap survived
 * review, so they get one here.
 */
describe("the entry points story.md promises stay unchanged", () => {
  it("still runs the same check through `bun run dep:check`", async () => {
    const manifest = JSON.parse(await readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    // Not merely "the key exists": it must still invoke the same script the
    // systemd unit does, or the two entry points have silently diverged.
    expect(manifest.scripts?.["dep:check"]).toBe("bash scripts/dep-check.sh");
  });

  it("still declares the same Bun floor in the manifest and both image stages", async () => {
    const manifest = JSON.parse(await readRepoFile("package.json")) as {
      engines?: Record<string, string>;
    };
    const declared = manifest.engines?.bun;
    expect(declared).toBe(">=1.3.0");

    // Both Dockerfile stages must agree with each other. A builder newer than
    // the runtime ships an artifact the runtime may not be able to run.
    const stages = [...(await readRepoFile("Dockerfile")).matchAll(/^FROM\s+(oven\/bun:\S+)/gm)]
      .map((match) => match[1]);
    expect(stages.length, "expected a multi-stage Dockerfile on oven/bun").toBe(2);
    expect(new Set(stages).size, `the two stages disagree: ${stages.join(" vs ")}`).toBe(1);

    // AGREEMENT IS NOT THE FLOOR, and this assertion exists because that
    // difference shipped: two stages both at `1.2-alpine` agree with each other
    // perfectly while sitting below the declared floor. Story 001 established
    // that every 1.2.x accepts `install.minimumReleaseAge` in silence and
    // applies no cooldown, so the floor is load-bearing — a build on 1.2 would
    // resolve packages this repository's own quarantine is meant to withhold,
    // and nothing would say so. Both properties are wanted; this one is added
    // beside the agreement check, never in place of it (004 R4.1, R4.4).
    //
    // The floor is READ from `engines.bun` rather than restated as `1.3` here,
    // so the next bump cannot leave the image behind: two sources of truth for
    // one floor desynchronise, which is the same class of defect as the
    // documentation drift story 004 also closes (004 R4.2).
    const floor = versionComponents(declared ?? "");
    expect(floor.length, `engines.bun declares no parseable version: ${declared}`)
      .toBeGreaterThan(0);

    for (const stage of stages) {
      const tag = stage.slice(stage.indexOf(":") + 1);
      const got = versionComponents(tag);
      // A tag with no numeric component — `latest`, `alpine` — FAILS rather
      // than passing by default. An unparseable tag is not evidence of
      // satisfying a floor; it is the absence of evidence (004 R4.3).
      expect(got.length, `image tag carries no parseable version: ${stage}`).toBeGreaterThan(0);
      expect(
        atLeast(got, floor),
        `${stage} is below the Bun floor declared by engines.bun (${declared})`,
      ).toBe(true);
    }
  });
});
