import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PathValidator } from "../../security/path-validator.js";

/**
 * Story 006, task 1.2 — R3.1. `validate` takes a SET OF ROOTS, and `"/"` stops being a
 * usable base.
 *
 * Measured 2026-08-12 against the shipped code: `validate(p, "/")` refused every real
 * path — `path.resolve("/") + path.sep` is `"//"` — while `""` and `"/"` were accepted.
 * Against a REAL confined base the same validator was measured correct: it accepted a
 * file inside the base and refused `/etc/hosts`, `..` traversal, URL-encoded and
 * double-encoded separators, a NUL byte, and a symlink escaping through `realpath`.
 *
 * So the prefix comparison is not the defect and must not be "repaired". The single most
 * important assertion in this file is the last one: a root of `"/"` must NOT become a way
 * to accept an arbitrary absolute path. Repairing the comparison while a caller can still
 * pass `"/"` converts a dead tool into a read-anything-and-POST-it primitive — measured,
 * with `absolutePathToRefiningFile: "/etc/passwd"` producing an outbound POST carrying
 * the file's contents.
 *
 * Contract pinned here (design.md `## Fix Approach 3`):
 *   `validate(inputPath: string, roots: readonly string[]): Promise<PathValidationResult>`
 *   accepted when the path is inside ANY root; an empty root set is refused outright.
 *
 * EVERY negative case below carries a positive control in the same test. Story 005
 * shipped a stub that could not fail, and five assertions passed against unfixed code;
 * here, a validator that simply refuses everything — which is exactly what the shipped
 * one does — must not be able to make this file green. Assertions are on `valid` and on
 * `normalizedPath`, never on an error message.
 */

const validator = new PathValidator();

let rootA: string;
let rootB: string;
let outside: string;
let fileInA: string;
let fileInB: string;
let secretOutside: string;
let symlinkInA: string;

const SECRET = "SECRET-CONTENT-NEVER-REACHABLE";

beforeAll(async () => {
  rootA = await realpath(await mkdtemp(path.join(tmpdir(), "magic-pv-a-")));
  rootB = await realpath(await mkdtemp(path.join(tmpdir(), "magic-pv-b-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "magic-pv-out-")));

  fileInA = path.join(rootA, "Button.tsx");
  fileInB = path.join(rootB, "Card.tsx");
  secretOutside = path.join(outside, "secret.env");
  symlinkInA = path.join(rootA, "escape.tsx");

  await writeFile(fileInA, "export const Button = () => null;\n");
  await writeFile(fileInB, "export const Card = () => null;\n");
  await writeFile(secretOutside, `${SECRET}\n`);
  await mkdir(path.join(rootA, "nested"), { recursive: true });
  await symlink(secretOutside, symlinkInA);
});

afterAll(async () => {
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** The positive control every negative test runs, so no test can pass vacuously. */
async function controlAccepts(): Promise<void> {
  const control = await validator.validate(fileInA, [rootA]);
  expect(control.valid).toBe(true);
  expect(control.normalizedPath).toBe(fileInA);
}

describe("PathValidator.validate — a path inside a configured root", () => {
  it("accepts a file inside the root and returns its resolved path", async () => {
    const result = await validator.validate(fileInA, [rootA]);

    expect(result.valid).toBe(true);
    expect(result.normalizedPath).toBe(fileInA);
  });

  it("accepts a file inside the second of two roots", async () => {
    const second = await validator.validate(fileInB, [rootA, rootB]);
    expect(second.valid).toBe(true);
    expect(second.normalizedPath).toBe(fileInB);

    const first = await validator.validate(fileInA, [rootA, rootB]);
    expect(first.valid).toBe(true);
    expect(first.normalizedPath).toBe(fileInA);
  });

  it("accepts a nested path inside the root", async () => {
    const nested = path.join(rootA, "nested", "New.tsx");

    const result = await validator.validate(nested, [rootA]);

    expect(result.valid).toBe(true);
    expect(result.normalizedPath).toBe(nested);
  });
});

describe("PathValidator.validate — a path outside every configured root", () => {
  it("refuses a file that is not inside any of the roots", async () => {
    const result = await validator.validate(fileInA, [rootB]);
    expect(result.valid).toBe(false);
    expect(result.normalizedPath).toBeUndefined();

    await controlAccepts();
  });

  it("refuses an absolute path in another directory", async () => {
    const result = await validator.validate(secretOutside, [rootA, rootB]);
    expect(result.valid).toBe(false);
    expect(result.normalizedPath).toBeUndefined();

    await controlAccepts();
  });

  it("refuses /etc/hosts", async () => {
    const result = await validator.validate("/etc/hosts", [rootA]);
    expect(result.valid).toBe(false);
    expect(result.normalizedPath).toBeUndefined();

    await controlAccepts();
  });

  it("refuses an empty root set rather than treating it as allow-everything", async () => {
    const result = await validator.validate(fileInA, []);
    expect(result.valid).toBe(false);
    expect(result.normalizedPath).toBeUndefined();

    await controlAccepts();
  });
});

describe("PathValidator.validate — the existing refusals stay intact", () => {
  it("refuses directory traversal out of the root", async () => {
    for (const input of [
      path.join(rootA, "..", "escape.tsx"),
      `${rootA}/../${path.basename(outside)}/secret.env`,
      "../../etc/passwd",
    ]) {
      const result = await validator.validate(input, [rootA]);
      expect(result.valid).toBe(false);
      expect(result.normalizedPath).toBeUndefined();
    }

    await controlAccepts();
  });

  it("refuses URL-encoded and double-encoded separators", async () => {
    for (const input of [
      `${rootA}/%2e%2e%2fetc/passwd`,
      `${rootA}/%2E%2E/secret`,
      `${rootA}/%252e%252e/etc/passwd`,
    ]) {
      const result = await validator.validate(input, [rootA]);
      expect(result.valid).toBe(false);
      expect(result.normalizedPath).toBeUndefined();
    }

    await controlAccepts();
  });

  it("refuses a NUL byte in the path", async () => {
    const result = await validator.validate(`${fileInA}\0.txt`, [rootA]);
    expect(result.valid).toBe(false);
    expect(result.normalizedPath).toBeUndefined();

    await controlAccepts();
  });

  it("refuses a symlink inside the root that points outside it", async () => {
    const result = await validator.validate(symlinkInA, [rootA]);
    expect(result.valid).toBe(false);
    expect(result.normalizedPath).toBeUndefined();

    await controlAccepts();
  });
});

/**
 * The regression this file exists for. Everything above is satisfied by a validator that
 * simply refuses; this is the one that stops the "obvious repair" from shipping a
 * read-anything primitive.
 */
describe("PathValidator.validate — a root of / is not a way in", () => {
  it("does not accept an arbitrary absolute path when the root set is the filesystem root", async () => {
    for (const input of ["/etc/hosts", "/etc/passwd", secretOutside, fileInA]) {
      const result = await validator.validate(input, ["/"]);
      expect(result.valid).toBe(false);
      expect(result.normalizedPath).toBeUndefined();
    }

    await controlAccepts();
  });

  it("does not widen a legitimate root set that also contains the filesystem root", async () => {
    for (const input of ["/etc/hosts", secretOutside]) {
      const result = await validator.validate(input, ["/", rootA]);
      expect(result.valid).toBe(false);
      expect(result.normalizedPath).toBeUndefined();
    }

    await controlAccepts();
  });

  /**
   * `""` and `"/"` were the ONLY two inputs the shipped validator accepted, precisely
   * because the base was `"/"`. Neither may be accepted against a root set that contains
   * the filesystem root, and the filesystem root is never inside a real project root.
   */
  it("does not accept the two inputs the / base used to accept", async () => {
    for (const roots of [["/"], ["/", rootA]] as const) {
      for (const input of ["", "/"]) {
        const result = await validator.validate(input, roots);
        expect(result.valid).toBe(false);
        expect(result.normalizedPath).toBeUndefined();
      }
    }

    const againstRealRoot = await validator.validate("/", [rootA]);
    expect(againstRealRoot.valid).toBe(false);
    expect(againstRealRoot.normalizedPath).toBeUndefined();

    await controlAccepts();
  });
});
