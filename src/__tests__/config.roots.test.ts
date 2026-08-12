import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import { parseConfig } from "../config.js";

/**
 * Story 006, task 1.1 — R3.1. The confinement base gets a meaning.
 *
 * `PathValidator` was called with a base of `"/"`, and `path.resolve("/") + path.sep`
 * is `"//"`, which no absolute path begins with. Measured 2026-08-12: every real path
 * was refused and `""` and `"/"` were the only two accepted inputs. The repair is a
 * configured SET OF ROOTS — and the configuration itself must make `"/"` and `""`
 * unrepresentable, because permitting either one reintroduces the defect by the front
 * door: a base of `"/"` with a working prefix comparison authorises every absolute file
 * on the machine, and `refine-ui` POSTs whatever it reads.
 *
 * Contract pinned here (design.md `## Fix Approach 3`, task 1.1):
 *   - field:     `allowedRoots: readonly string[]`, default `[process.cwd()]`
 *   - env var:   `ALLOWED_ROOTS`, following `MAX_FILE_SIZE` / `MAX_BODY_SIZE`
 *   - CLI:       `ALLOWED_ROOTS=<list>`, through the existing `parseCliArgs` patterns
 *   - separator: `path.delimiter` — `:` on POSIX, `;` on Windows. The platform
 *     convention for a list of filesystem paths, the same one `PATH` uses, and the only
 *     one that stays correct on both platforms.
 *   - every root is absolute by the time `parseConfig` returns, so a relative root
 *     cannot be resolved differently at each later use.
 *
 * An ABSENT `ALLOWED_ROOTS` means "use the default". An explicitly EMPTY one is a
 * configuration error, not a request for the default — silently widening or narrowing a
 * security boundary on an empty string is how the original defect reads to a user.
 */

/** Two synthetic absolute roots. Nothing is read from disk here — config never stats. */
const ROOT_A = path.resolve(path.sep, "srv", "magic-root-a");
const ROOT_B = path.resolve(path.sep, "srv", "magic-root-b");

describe("parseConfig — allowedRoots", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalArgv: string[];

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
    process.env.TWENTY_FIRST_API_KEY = "test-api-key-123";
    delete process.env.ALLOWED_ROOTS;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it("defaults to the working directory", () => {
    const config = parseConfig();

    expect(config.allowedRoots).toEqual([process.cwd()]);
    expect(path.isAbsolute(config.allowedRoots[0] as string)).toBe(true);
  });

  it("parses a configured root", () => {
    process.env.ALLOWED_ROOTS = ROOT_A;

    expect(parseConfig().allowedRoots).toEqual([ROOT_A]);
  });

  it("parses a list of roots separated by path.delimiter", () => {
    process.env.ALLOWED_ROOTS = `${ROOT_A}${path.delimiter}${ROOT_B}`;

    expect(parseConfig().allowedRoots).toEqual([ROOT_A, ROOT_B]);
  });

  it("resolves a relative root to an absolute path", () => {
    process.env.ALLOWED_ROOTS = `src${path.delimiter}.`;

    const roots = parseConfig().allowedRoots;

    expect(roots).toEqual([path.resolve("src"), path.resolve(".")]);
    for (const root of roots) {
      expect(path.isAbsolute(root)).toBe(true);
    }
  });

  it("takes the CLI value over the environment", () => {
    process.env.ALLOWED_ROOTS = ROOT_B;
    process.argv = [...process.argv, `ALLOWED_ROOTS=${ROOT_A}`];

    expect(parseConfig().allowedRoots).toEqual([ROOT_A]);
  });

  it("refuses an empty value", () => {
    process.env.ALLOWED_ROOTS = "";

    expect(() => parseConfig()).toThrow();
  });

  it("refuses an empty-string root inside a list", () => {
    process.env.ALLOWED_ROOTS = `${ROOT_A}${path.delimiter}${path.delimiter}${ROOT_B}`;

    expect(() => parseConfig()).toThrow();
  });

  it("refuses the filesystem root", () => {
    process.env.ALLOWED_ROOTS = path.sep;

    expect(() => parseConfig()).toThrow();
  });

  it("refuses a list that contains the filesystem root", () => {
    process.env.ALLOWED_ROOTS = `${ROOT_A}${path.delimiter}${path.sep}`;

    expect(() => parseConfig()).toThrow();
  });

  /**
   * Catch-all over the shapes that could smuggle `""` or the filesystem root back in.
   * Refusing is always an acceptable answer; RETURNING one of them never is. `/..`
   * matters most: it is not literally `"/"` and it resolves to it.
   */
  it("never returns an empty, relative or filesystem-root entry for any hostile value", () => {
    const hostile = [
      "",
      " ",
      "   ",
      path.sep,
      `${path.sep}${path.sep}`,
      `${path.sep}..`,
      `${path.sep}..${path.sep}..`,
      path.delimiter,
      `${ROOT_A}${path.delimiter}`,
      `${path.delimiter}${ROOT_A}`,
      `${path.sep}${path.delimiter}${ROOT_A}`,
      `${ROOT_A}${path.delimiter}${path.sep}..`,
    ];

    for (const value of hostile) {
      process.env.ALLOWED_ROOTS = value;

      let roots: readonly string[];
      try {
        roots = parseConfig().allowedRoots;
      } catch {
        continue; // refusing the whole configuration is always acceptable
      }

      expect(Array.isArray(roots)).toBe(true);
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) {
        expect(typeof root).toBe("string");
        expect(root).not.toBe("");
        expect(path.isAbsolute(root)).toBe(true);
        // `path.parse(r).root === r` is true exactly for `/` and for a Windows drive root.
        expect(path.parse(root).root).not.toBe(root);
      }
    }
  });
});

describe("parseConfig — unchanged by the addition of allowedRoots", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TWENTY_FIRST_API_KEY = "test-api-key-123";
    process.env.ALLOWED_ROOTS = ROOT_A;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("keeps every other default while roots are configured", () => {
    const config = parseConfig();

    expect(config.apiKey).toBe("test-api-key-123");
    expect(config.logLevel).toBe("info");
    expect(config.timeout).toBe(30_000);
    expect(config.maxFileSize).toBe(1_048_576);
    expect(config.maxBodySize).toBe(1_048_576);
    expect(config.debug).toBe(false);
    expect(config.canvas).toBe(false);
    expect(config.github).toBe(false);
    expect(config.allowedRoots).toEqual([ROOT_A]);
  });

  it("still returns a frozen object", () => {
    const config = parseConfig();

    expect(Object.isFrozen(config)).toBe(true);
    expect(config.allowedRoots).toEqual([ROOT_A]);
  });

  it("still requires an API key even when roots are configured", () => {
    delete process.env.TWENTY_FIRST_API_KEY;
    delete process.env.API_KEY;

    expect(() => parseConfig()).toThrow();
  });
});
