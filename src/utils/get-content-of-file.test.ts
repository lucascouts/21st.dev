import * as fc from "fast-check";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { getContentOfFile } from "./get-content-of-file.js";

describe("getContentOfFile", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-reader-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Property 13: File Size Configuration
   * For any positive integer value set in the MAX_FILE_SIZE environment variable,
   * the File_Reader SHALL use that exact value (in bytes) as the maximum file size limit.
   *
   * **Validates: Requirements 8.2**
   */
  describe("Property 13: File Size Configuration", () => {
    const originalEnv = process.env.MAX_FILE_SIZE;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.MAX_FILE_SIZE = originalEnv;
      } else {
        delete process.env.MAX_FILE_SIZE;
      }
    });

    it("should respect MAX_FILE_SIZE environment variable for any positive integer", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate positive integers for file size limits (reasonable range: 1 to 10MB)
          fc.integer({ min: 1, max: 10 * 1024 * 1024 }),
          async (maxSize) => {
            // Set the environment variable
            process.env.MAX_FILE_SIZE = String(maxSize);

            // Create files with unique names (use relative paths for getContentOfFile)
            const atLimitFileName = `at-limit-${maxSize}.txt`;
            const overLimitFileName = `over-limit-${maxSize}.txt`;
            const atLimitFile = path.join(tempDir, atLimitFileName);
            const overLimitFile = path.join(tempDir, overLimitFileName);
            
            const atLimitContent = "x".repeat(maxSize);
            const overLimitContent = "x".repeat(maxSize + 1);
            await fs.writeFile(atLimitFile, atLimitContent);
            await fs.writeFile(overLimitFile, overLimitContent);

            // File at limit should be readable (use RELATIVE path)
            const atLimitResult = await getContentOfFile(atLimitFileName, {
              basePath: tempDir,
              validatePath: true,
            });

            // File over limit should return empty string (use RELATIVE path)
            const overLimitResult = await getContentOfFile(overLimitFileName, {
              basePath: tempDir,
              validatePath: true,
            });

            // Cleanup
            await fs.unlink(atLimitFile).catch(() => {});
            await fs.unlink(overLimitFile).catch(() => {});

            return atLimitResult === atLimitContent && overLimitResult === "";
          }
        ),
        { numRuns: 20 } // Reduced runs due to file I/O overhead
      );
    });

    it("should use options.maxSize when provided, overriding environment variable", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 10000 }),
          fc.integer({ min: 100, max: 10000 }),
          async (envSize, optionSize) => {
            // Set environment to a different value
            process.env.MAX_FILE_SIZE = String(envSize);

            // Create a file sized between the two limits
            const testSize = Math.min(envSize, optionSize) + 1;
            const testFileName = `option-test-${testSize}-${Date.now()}.txt`;
            const testFile = path.join(tempDir, testFileName);
            const content = "x".repeat(testSize);
            await fs.writeFile(testFile, content);

            // Read with explicit maxSize option (use RELATIVE path)
            const result = await getContentOfFile(testFileName, {
              basePath: tempDir,
              validatePath: true,
              maxSize: optionSize,
            });

            // Cleanup
            await fs.unlink(testFile).catch(() => {});

            // If testSize > optionSize, should return empty
            // If testSize <= optionSize, should return content
            if (testSize > optionSize) {
              return result === "";
            } else {
              return result === content;
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should default to 1MB when MAX_FILE_SIZE is not set", async () => {
      delete process.env.MAX_FILE_SIZE;

      const defaultLimit = 1024 * 1024; // 1MB

      // Create files (use relative paths for getContentOfFile)
      const underLimitFileName = "under-default.txt";
      const overLimitFileName = "over-default.txt";
      const underLimitFile = path.join(tempDir, underLimitFileName);
      const overLimitFile = path.join(tempDir, overLimitFileName);
      
      const underLimitContent = "x".repeat(defaultLimit - 1);
      const overLimitContent = "x".repeat(defaultLimit + 1);
      await fs.writeFile(underLimitFile, underLimitContent);
      await fs.writeFile(overLimitFile, overLimitContent);

      // Use RELATIVE paths
      const underResult = await getContentOfFile(underLimitFileName, {
        basePath: tempDir,
        validatePath: true,
      });

      const overResult = await getContentOfFile(overLimitFileName, {
        basePath: tempDir,
        validatePath: true,
      });

      // Cleanup
      await fs.unlink(underLimitFile).catch(() => {});
      await fs.unlink(overLimitFile).catch(() => {});

      expect(underResult).toBe(underLimitContent);
      expect(overResult).toBe("");
    });
  });

  describe("Path Validation Integration", () => {
    it("should reject paths with traversal sequences", async () => {
      const result = await getContentOfFile("../../../etc/passwd", {
        basePath: tempDir,
        validatePath: true,
      });
      expect(result).toBe("");
    });

    it("should accept valid paths within base directory", async () => {
      const testFileName = "valid-file.txt";
      const testFile = path.join(tempDir, testFileName);
      const content = "test content";
      await fs.writeFile(testFile, content);

      // Use RELATIVE path
      const result = await getContentOfFile(testFileName, {
        basePath: tempDir,
        validatePath: true,
      });

      await fs.unlink(testFile).catch(() => {});
      expect(result).toBe(content);
    });
  });
});
