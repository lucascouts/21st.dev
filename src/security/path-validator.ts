import { realpath } from "node:fs/promises";
import * as path from "node:path";

/**
 * `allowedBasePaths` used to live here, assigned in the constructor and read
 * nowhere. A field that looks like the boundary but is not one is worse than no
 * field at all in this file, so it is gone: the boundary is the `roots` argument
 * to `validate`, which cannot be forgotten.
 */
export interface PathValidatorOptions {
  followSymlinks?: boolean;
}

export interface PathValidationResult {
  valid: boolean;
  normalizedPath?: string;
  error?: string;
}

/** A root set that passed its own checks, or the reason it did not. */
type NormalizedRoots =
  | { readonly ok: true; readonly roots: readonly string[] }
  | { readonly ok: false; readonly error: string };

export class PathValidator {
  private readonly followSymlinks: boolean;

  constructor(options?: PathValidatorOptions) {
    this.followSymlinks = options?.followSymlinks ?? true;
  }

  /**
   * Confines `inputPath` to `roots` (R3.1). A path is accepted when it is inside
   * ANY root; the resolved path of the first root that contains it is returned.
   *
   * The parameter is a SET rather than one base because `validate(p, "/")` used
   * to be a legal call that disabled the whole check, and a signature that can
   * express the call which voids it will eventually be called that way. An empty
   * set is refused outright — neither "allow everything" nor "allow nothing",
   * both of which hide a misconfiguration — and so is a set containing the
   * filesystem root, which confines nothing.
   */
  async validate(inputPath: string, roots: readonly string[]): Promise<PathValidationResult> {
    const normalizedRoots = this.normalizeRoots(roots);
    if (!normalizedRoots.ok) {
      return { valid: false, error: normalizedRoots.error };
    }

    if (inputPath.includes("\0")) {
      return {
        valid: false,
        error: "Path contains a NUL byte",
      };
    }

    if (this.containsTraversal(inputPath)) {
      return {
        valid: false,
        error: "Path contains directory traversal sequences",
      };
    }

    try {
      for (const root of normalizedRoots.roots) {
        const resolvedPath = await this.resolveWithinRoot(inputPath, root);
        if (resolvedPath !== null) {
          return { valid: true, normalizedPath: resolvedPath };
        }
      }

      return {
        valid: false,
        error: "Path resolves outside every allowed root",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { valid: false, error: message };
    }
  }

  containsTraversal(inputPath: string): boolean {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(inputPath);
    } catch {
      decodedPath = inputPath;
    }

    const normalizedPath = decodedPath.replace(/\\/g, "/");

    const traversalPatterns = [
      /\.\./,
      /\.\.%/,
      /%2e%2e/i,
      /%252e%252e/i,
      /\.\.\//,
      /\/\.\./,
      /\.\.\\/,
      /\\\.\./,
    ];

    for (const pattern of traversalPatterns) {
      if (pattern.test(inputPath) || pattern.test(normalizedPath)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Resolves every root once, and refuses the whole call if any of them is not a
   * boundary. Refusing beats silently dropping the offending entry: a root set
   * containing `"/"` is a defect in whoever built it, and a validator that
   * quietly repairs it hides that defect instead of surfacing it.
   *
   * The filesystem root is refused on the RESOLVED value, not the raw string —
   * `path.resolve` maps `"//"`, `"/.."` and `"/../.."` all to `"/"`, so a check
   * against the literal `"/"` misses each of them. `path.parse(r).root === r` is
   * true exactly for `/` and for a Windows drive root. This mirrors `config.ts`,
   * which already refuses to PRODUCE such a root; the check lives here too so
   * the guarantee holds for any caller, not just the configured one.
   */
  private normalizeRoots(roots: readonly string[]): NormalizedRoots {
    if (roots.length === 0) {
      return { ok: false, error: "No allowed root configured; at least one is required" };
    }

    const normalized: string[] = [];

    for (const root of roots) {
      if (root.length === 0) {
        return { ok: false, error: "An allowed root must not be empty" };
      }

      const normalizedRoot = path.resolve(root);
      if (path.parse(normalizedRoot).root === normalizedRoot) {
        return { ok: false, error: "The filesystem root is not a valid allowed root" };
      }

      normalized.push(normalizedRoot);
    }

    return { ok: true, roots: normalized };
  }

  /**
   * The resolved path when `root` contains it, `null` when it does not.
   *
   * `null` rather than a throw because containment is asked once per root: the
   * first root failing to contain a path says nothing about the next one.
   * A genuine filesystem error still propagates and fails the call closed.
   */
  private async resolveWithinRoot(inputPath: string, root: string): Promise<string | null> {
    const candidate = path.resolve(root, inputPath);
    const resolvedPath = this.followSymlinks ? await this.realPathIfExists(candidate) : candidate;

    return this.isWithin(resolvedPath, root) ? resolvedPath : null;
  }

  /**
   * The path a read would actually reach: `realpath` for a file that exists, so
   * a symlink inside a root pointing out of it is compared where it lands, not
   * where it sits. A path that does not exist yet has nothing to follow.
   */
  private async realPathIfExists(candidate: string): Promise<string> {
    try {
      const file = Bun.file(candidate);
      const exists = await file.exists();
      if (!exists) {
        return candidate;
      }

      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }

  /**
   * Unchanged in form from the shipped comparison, deliberately. Measured
   * correct against a real confined base: it accepts a file inside the base and
   * refuses `/etc/hosts`, traversal, and a symlink escaping through `realpath`.
   * The defect this file fixes was the base, never this expression. The trailing
   * separator is what stops `/home/user/project-evil` matching `/home/user/project`.
   */
  private isWithin(candidate: string, root: string): boolean {
    return candidate.startsWith(root + path.sep) || candidate === root;
  }
}
