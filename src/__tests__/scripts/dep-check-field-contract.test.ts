import { describe, it, expect, beforeAll } from "bun:test";

import { readRepoFile } from "./dep-check-harness.js";

/**
 * What the script says its freshness fields MEAN (story 004, R3.2).
 *
 * `examined_count` is `($recorded | length)` — rows read out of `bun.lock`. The
 * field glossary called it "how many packages the freshness half actually looked
 * at", the in-function comment called it "how many packages were compared", and
 * `CHANGELOG.md` called it packages read from the lockfile. Three descriptions,
 * one number, and with unmatched keys present the first two stop being true:
 * rows read and keys compared diverge, and only the first was ever reported.
 *
 * A wrong gloss is not cosmetic here. Story 003 exists because a header promised
 * "what a re-resolution would produce" while the code answered a narrower
 * question, and prose nobody can check is how that survives review. So the
 * documented contract gets assertions, like the mechanism does.
 *
 * This file is a sibling of `dep-check-contract.test.ts`, not a replacement:
 * that one pins the claims story 003 got wrong, this one pins the field
 * vocabulary story 004 corrects and extends. Both are deliberately tolerant of
 * wording and strict about substance.
 */

let script: string;
/** The leading comment block: everything before the first line of code. */
let header: string;
/** Everything after it — where the in-function commentary lives. */
let body: string;

beforeAll(async () => {
  script = await readRepoFile("scripts/dep-check.sh");
  const lines: string[] = [];
  for (const line of script.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") lines.push(line);
    else if (lines.length > 0) break;
  }
  header = lines.join("\n");
  body = script.slice(header.length);
});

/**
 * One entry of the header's field glossary, flattened to a single line.
 *
 * Entries look like `#     name  description`, with continuation lines indented
 * under the description. Boundaries are found structurally rather than by
 * counting columns, so a reflowed header still parses; `null` means the glossary
 * has no entry for that field at all.
 */
function glossaryEntry(field: string): string | null {
  const lines = header.split("\n");
  const startPattern = new RegExp(`^#\\s{3,}${field}\\s\\s+\\S`);
  const otherEntry = /^#\s{3,}[a-z_]+\s\s+\S/;
  const newParagraph = /^#\s{0,3}\S/;

  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return null;

  const collected = [lines[start] as string];
  for (const line of lines.slice(start + 1)) {
    if (otherEntry.test(line) || newParagraph.test(line)) break;
    if (line.trim() === "" || line.trim() === "#") break;
    collected.push(line);
  }
  return collected
    .map((line) => line.replace(/^#\s*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The header paragraph documenting one exit status, flattened. */
function exitStatusEntry(status: number): string | null {
  const lines = header.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#\\s+${status}\\s\\s+\\S`).test(line));
  if (start < 0) return null;

  const collected = [lines[start] as string];
  for (const line of lines.slice(start + 1)) {
    if (/^#\s+\d\s\s+\S/.test(line) || /^#\s{0,3}\S/.test(line)) break;
    if (line.trim() === "" || line.trim() === "#") break;
    collected.push(line);
  }
  return collected
    .map((line) => line.replace(/^#\s*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The in-function commentary around the first mention of a field, flattened. */
function bodyGloss(field: string): string {
  const at = body.indexOf(field);
  if (at < 0) return "";
  return body
    .slice(Math.max(0, at - 240), at + 480)
    .replace(/^\s*#\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("dep-check documents the fields it reports (R3.2)", () => {
  describe("examined_count is described as what it computes", () => {
    it("has a glossary entry that calls it rows read from the recorded lockfile", () => {
      const entry = glossaryEntry("examined_count");
      expect(entry, "the header's field glossary has no examined_count entry").not.toBeNull();
      expect(entry ?? "").toMatch(/rows?\s+(?:were\s+)?read/i);
    });

    it("no longer describes it as a measure of what was compared", () => {
      // `($recorded | length)` is rows READ. Calling it packages compared was
      // true only while every fixture had identical key sets — the invariant
      // that hid the diff defect.
      const entry = glossaryEntry("examined_count") ?? "";
      expect(entry).not.toMatch(/were compared|packages compared|actually looked at/i);
    });

    it("says the same thing where the diff itself is commented", () => {
      // Two documents, one number: the in-function comment at the `jq` program
      // is the other place a reader learns what the field means, and it is the
      // one that disagreed with `CHANGELOG.md`.
      const gloss = bodyGloss("examined_count");
      expect(gloss, "no comment in the script body mentions examined_count at all").not.toBe("");
      expect(gloss).not.toMatch(/examined_count[^.]{0,80}(were compared|actually looked at)/i);
      expect(gloss).toMatch(/examined_count[\s\S]{0,240}rows?\s+(?:were\s+)?read/i);
    });
  });

  describe("the new fields are part of the documented contract", () => {
    it("documents compared_count as the keys present in both lockfiles", () => {
      const entry = glossaryEntry("compared_count");
      expect(
        entry,
        "the header's field glossary has no compared_count entry, so a reader cannot tell it " +
          "apart from examined_count",
      ).not.toBeNull();
      expect(entry ?? "").toMatch(/both/i);
    });

    it("documents unmatched, including both directions it can report", () => {
      const entry = glossaryEntry("unmatched");
      expect(entry, "the header's field glossary has no unmatched entry").not.toBeNull();
      expect(entry ?? "").toMatch(/recorded_only/);
      expect(entry ?? "").toMatch(/resolved_only/);
    });

    it("shows all three in the worked output example", () => {
      // The example is what most readers actually read; a field documented only
      // in the glossary is a field half the audience never sees.
      //
      // The slice ENDS at the glossary heading rather than at the end of the
      // header (open finding L10). Reaching the end let the glossary satisfy
      // these three assertions on its own, which is the one thing this test is
      // not about.
      const anchor = header.indexOf("OUTPUT CONTRACT");
      expect(anchor, "the header has no OUTPUT CONTRACT block").toBeGreaterThan(-1);
      const end = header.indexOf("FRESHNESS FIELDS", anchor);
      expect(
        end,
        "the header has no FRESHNESS FIELDS heading to bound the worked example",
      ).toBeGreaterThan(anchor);
      const contract = header.slice(Math.max(anchor, 0), end);
      expect(contract).toContain("compared_count");
      expect(contract).toContain('"unmatched"');
      expect(contract).toContain("unmatched_count");
    });
  });

  describe("the exit-code block covers the new way to exit 1", () => {
    it("names the unmatched condition beside vulnerabilities and updates", () => {
      // This is the first exit-1 driver that does not appear in
      // `outdated_count`, so a reader of the exit-code block alone would
      // otherwise have no way to account for the status.
      const entry = exitStatusEntry(1);
      expect(entry, "the header documents no exit status 1").not.toBeNull();
      expect(entry ?? "").toMatch(/unmatched|only one lockfile|exactly one of the two/i);
    });

    it("still documents the same three statuses and their precedence", () => {
      expect(exitStatusEntry(0) ?? "").toMatch(/clean/i);
      expect(exitStatusEntry(2) ?? "").toMatch(/incomplete|errored|partial/i);
      expect(header).toMatch(/precedence/i);
    });
  });

  describe("the requirement-ID legend stays unambiguous", () => {
    it("names story 004, the third to number its clauses R1.x", () => {
      // The file's own rule is that a requirement ID names its story, because
      // 002, 003 and now 004 all have an R1.1. A legend that stops at 003 makes
      // every new citation ambiguous by that rule.
      const anchor = header.indexOf("Requirement IDs name their story");
      expect(anchor, "the header no longer carries the requirement-ID legend").toBeGreaterThan(-1);
      const legend = header.slice(anchor, anchor + 400);
      expect(legend).toMatch(/\b004\b/);
    });
  });
});
