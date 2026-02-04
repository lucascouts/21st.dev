import * as fc from "fast-check";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { PathValidator } from "./path-validator.js";

describe("PathValidator", () => {
  let validator: PathValidator;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-validator-test-"));
    validator = new PathValidator();
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Property 1: Path Traversal Rejection
   * For any file path containing ".." sequences or resolving to a location
   * outside the allowed base directory, the Path_Validator SHALL reject
   * the path and return an error.
   * 
   * **Validates: Requirements 2.1, 2.2**
   */
  describe("Property 1: Path Traversal Rejection", () => {
    it("should reject paths containing '..' sequences", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate paths with ".." traversal sequences
          fc.oneof(
            fc.constant(".."),
            fc.constant("../"),
            fc.constant("..\\"),
            fc.tuple(fc.string(), fc.constant(".."), fc.string()).map(
              ([prefix, traversal, suffix]) => `${prefix}/${traversal}/${suffix}`
            ),
            fc.tuple(fc.string(), fc.constant("..")).map(
              ([prefix, traversal]) => `${prefix}/${traversal}`
            ),
            fc.tuple(fc.constant(".."), fc.string()).map(
              ([traversal, suffix]) => `${traversal}/${suffix}`
            ),
            // URL-encoded variants
            fc.constant("%2e%2e"),
            fc.constant("%2E%2E"),
            fc.constant("..%2f"),
            fc.constant("%2e%2e%2f"),
          ),
          async (maliciousPath) => {
            const result = await validator.validate(maliciousPath, tempDir);
            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject absolute paths outside the base directory", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate absolute paths that are outside tempDir
          fc.oneof(
            fc.constant("/etc/passwd"),
            fc.constant("/tmp/other"),
            fc.constant("/var/log/syslog"),
            fc.string({ minLength: 1 }).map(s => `/outside/${s.replace(/[^a-zA-Z0-9]/g, "")}`),
          ),
          async (absolutePath) => {
            const result = await validator.validate(absolutePath, tempDir);
            // Should be invalid since it's outside the base directory
            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 2: Valid Path Acceptance
   * For any relative file path that resolves to a location within the allowed
   * base directory and does not contain traversal sequences, the Path_Validator
   * SHALL accept the path and return the normalized path.
   * 
   * **Validates: Requirements 2.4**
   */
  describe("Property 2: Valid Path Acceptance", () => {
    it("should accept valid relative paths within the base directory", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate valid relative paths (alphanumeric with some allowed chars)
          fc.array(
            fc.string({ minLength: 1, maxLength: 10 })
              .filter(s => !s.includes(".."))
              .map(s => s.replace(/[^a-zA-Z0-9_-]/g, ""))
              .filter(s => s.length > 0),
            { minLength: 1, maxLength: 3 }
          ).map(parts => parts.join("/")),
          async (validPath) => {
            if (!validPath || validPath.includes("..")) {
              return true; // Skip invalid generated paths
            }
            const result = await validator.validate(validPath, tempDir);
            if (!result.valid) {
              return false;
            }
            // Verify the normalized path starts with the base directory
            return result.normalizedPath?.startsWith(tempDir) ?? false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should return normalized path for valid inputs", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("file.txt", "subdir/file.txt", "a/b/c.js"),
          async (validPath) => {
            const result = await validator.validate(validPath, tempDir);
            return (
              result.valid === true &&
              result.normalizedPath !== undefined &&
              path.isAbsolute(result.normalizedPath)
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
