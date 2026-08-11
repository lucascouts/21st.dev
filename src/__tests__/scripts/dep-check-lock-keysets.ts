/**
 * Lockfile KEY-SET mutators for the `scripts/dep-check.sh` fixtures
 * (story 004, R2.1-R2.3, R3.1, R3.3).
 *
 * `dep-check-harness.ts` already carries `rewriteLockVersion`, and until this
 * story it was the only lockfile mutator in the suite. It changes a version and
 * nothing else, so every fixture the suite has ever built had the SAME key set
 * on both sides of the diff. That is what hid the defect this story closes: with
 * equal key sets, `examined_count` and `compared_count` coincide, and a diff that
 * visits only the recorded side visits everything there is. A suite whose
 * fixtures all satisfy an invariant cannot detect that the code depends on it.
 *
 * These two helpers make the key sets differ. They live in a NEW module rather
 * than inside the harness on purpose: the harness is working story-003
 * infrastructure, and editing it to add a capability risks regressing guarantees
 * that have nothing to do with this story.
 *
 * TWO DISCIPLINES ARE LOAD-BEARING, and both are copied from
 * `rewriteLockVersion` (`dep-check-harness.ts:445-463`):
 *
 *  1. **Throw on surprise.** A mutator that silently matches zero rows — or
 *     three — produces a fixture describing a scenario nobody wrote, and the
 *     test built on it passes while proving something else.
 *  2. **Emit the row shape the script's `sed` matches**
 *     (`scripts/dep-check.sh:184`): `  "key": ["name@version", ...],`. A subtly
 *     different shape is not a parse error — the extractor simply does not see
 *     the row, so the fixture silently loses the key it was built around and the
 *     scenario stops being the scenario. Both helpers therefore re-read the
 *     mutated text with the harness's own parser and throw unless the key set
 *     moved exactly as asked.
 */

import { parseLockEntries, type LockEntry } from "./dep-check-harness.js";

/** Matches one package row, in the same shape `LOCK_ROW_SED` matches. */
const ROW_PATTERN = /^\s*"([^"]+)":\s*\["([^"]+)"/;

/** A synthetic lockfile row. `key` is the lockfile key, which is not always the name. */
export interface LockRow extends LockEntry {
  /**
   * Integrity hash placed in position 4 of the row, purely so the fixture looks
   * like a real one. The check reduces every row to `key -> name@version` and
   * discards the rest, so nothing reads this — which is itself recorded as the
   * highest-severity remaining blind spot in story.md's Out of Scope.
   */
  integrity?: string;
}

/** The row shape the extractor matches, and the only shape these helpers emit. */
function renderRow(row: LockRow, indent: string): string {
  const integrity = row.integrity ?? `sha512-${row.name.replace(/[^a-zA-Z0-9]/g, "")}fixture==`;
  return `${indent}"${row.key}": ["${row.name}@${row.version}", "", {}, "${integrity}"],`;
}

/** Index of every line that declares the given lockfile key, in file order. */
function rowLineIndexes(lines: readonly string[], key: string): number[] {
  const found: number[] = [];
  lines.forEach((line, index) => {
    const match = line.match(ROW_PATTERN);
    if (match && match[1] === key) found.push(index);
  });
  return found;
}

/**
 * Adds one package row to a lockfile — the shape a re-resolution produces when
 * it resolves something the recorded lockfile never recorded.
 *
 * @param lockText the lockfile to mutate; never modified in place.
 * @param row the row to add. Its key must not already be present.
 * @param options.after key of the row to insert after. Defaults to the LAST row
 *   in the file, which keeps the insertion inside the `"packages"` object
 *   without needing to understand that object's boundaries.
 */
export function addLockRow(
  lockText: string,
  row: LockRow,
  options: { after?: string } = {},
): string {
  const lines = lockText.split("\n");
  const before = parseLockEntries(lockText);

  if (before.some((entry) => entry.key === row.key)) {
    throw new Error(`cannot add lockfile key ${row.key}: the lockfile already records it`);
  }

  let anchor: number;
  if (options.after === undefined) {
    const rows = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => ROW_PATTERN.test(line));
    const last = rows.at(-1);
    if (!last) throw new Error("cannot add a lockfile row: the lockfile records no rows at all");
    anchor = last.index;
  } else {
    const matches = rowLineIndexes(lines, options.after);
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one lockfile row for anchor key ${options.after}, ` +
          `found ${matches.length}`,
      );
    }
    anchor = matches[0] as number;
  }

  const indent = (lines[anchor] as string).match(/^(\s*)/)?.[1] ?? "    ";
  const mutated = [
    ...lines.slice(0, anchor + 1),
    "",
    renderRow(row, indent),
    ...lines.slice(anchor + 1),
  ].join("\n");

  // The row shape is the whole point, so it is verified rather than trusted:
  // re-read with the same parser the check's `sed` mirrors, and demand the new
  // key comes back with the name and version it was given.
  const after = parseLockEntries(mutated);
  const added = after.filter((entry) => entry.key === row.key);
  if (added.length !== 1) {
    throw new Error(
      `the added row for ${row.key} is not extractable: the row matcher found ` +
        `${added.length} of it, so the fixture would silently omit the key it was built to add`,
    );
  }
  const [entry] = added as [LockEntry];
  if (entry.name !== row.name || entry.version !== row.version) {
    throw new Error(
      `the added row for ${row.key} extracts as ${entry.name}@${entry.version}, ` +
        `not ${row.name}@${row.version}`,
    );
  }
  if (after.length !== before.length + 1) {
    throw new Error(
      `adding ${row.key} changed the extracted row count by ${after.length - before.length}, not by 1`,
    );
  }

  return mutated;
}

/**
 * Removes one package row from a lockfile — the shape a re-resolution produces
 * when it no longer resolves something the recorded lockfile records.
 *
 * @param key the lockfile key to remove. Exactly one row must declare it.
 */
export function removeLockRow(lockText: string, key: string): string {
  const lines = lockText.split("\n");
  const before = parseLockEntries(lockText);
  const matches = rowLineIndexes(lines, key);

  if (matches.length !== 1) {
    throw new Error(`expected exactly one lockfile row for key ${key}, found ${matches.length}`);
  }

  const target = matches[0] as number;
  const mutated = lines.filter((_line, index) => index !== target).join("\n");

  const after = parseLockEntries(mutated);
  if (after.some((entry) => entry.key === key)) {
    throw new Error(`the row for ${key} is still extractable after removing it`);
  }
  if (after.length !== before.length - 1) {
    throw new Error(
      `removing ${key} changed the extracted row count by ${after.length - before.length}, not by -1`,
    );
  }

  return mutated;
}
