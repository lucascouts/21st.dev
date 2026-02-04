import * as path from "path";
import * as fs from "fs/promises";

export interface PathValidatorOptions {
  allowedBasePaths?: string[];
  followSymlinks?: boolean;
}

export interface PathValidationResult {
  valid: boolean;
  normalizedPath?: string;
  error?: string;
}

/**
 * Validates file paths to prevent directory traversal attacks.
 * Implements security rules per Requirements 2.1, 2.2, 2.3, 2.4
 */
export class PathValidator {
  private allowedBasePaths: string[];
  private followSymlinks: boolean;

  constructor(options?: PathValidatorOptions) {
    this.allowedBasePaths = options?.allowedBasePaths ?? [];
    this.followSymlinks = options?.followSymlinks ?? true;
  }

  /**
   * Validates a file path against security rules
   * @param inputPath - The path to validate
   * @param basePath - The base directory to resolve relative paths against
   * @returns Validation result with normalized path or error
   */
  async validate(inputPath: string, basePath: string): Promise<PathValidationResult> {
    // Check for traversal sequences before any normalization
    if (this.containsTraversal(inputPath)) {
      return {
        valid: false,
        error: "Path contains directory traversal sequences",
      };
    }

    try {
      const resolvedPath = await this.resolvePath(inputPath, basePath);
      
      // Verify the resolved path is within the base path
      const normalizedBase = path.resolve(basePath);
      if (!resolvedPath.startsWith(normalizedBase + path.sep) && resolvedPath !== normalizedBase) {
        return {
          valid: false,
          error: "Path resolves outside the allowed base directory",
        };
      }

      return {
        valid: true,
        normalizedPath: resolvedPath,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        valid: false,
        error: message,
      };
    }
  }

  /**
   * Checks if a path contains directory traversal sequences
   * Handles various encoding bypasses
   */
  containsTraversal(inputPath: string): boolean {
    // Decode URL-encoded characters to catch encoded traversal attempts
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(inputPath);
    } catch {
      // If decoding fails, use original path
      decodedPath = inputPath;
    }

    // Normalize path separators for cross-platform check
    const normalizedPath = decodedPath.replace(/\\/g, "/");

    // Check for ".." in various forms
    const traversalPatterns = [
      /\.\./,                    // Basic ".."
      /\.\.%/,                   // Partially encoded
      /%2e%2e/i,                 // Fully URL-encoded
      /%252e%252e/i,             // Double URL-encoded
      /\.\.\//,                  // "../"
      /\/\.\./,                  // "/.."
      /\.\.\\/,                  // "..\"
      /\\\.\./,                  // "\.."
    ];

    for (const pattern of traversalPatterns) {
      if (pattern.test(inputPath) || pattern.test(normalizedPath)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Resolves and normalizes a path, checking symlinks if enabled
   */
  private async resolvePath(inputPath: string, basePath: string): Promise<string> {
    // Normalize the base path
    const normalizedBase = path.resolve(basePath);
    
    // Resolve the input path relative to base
    const resolvedPath = path.resolve(normalizedBase, inputPath);

    // If following symlinks, resolve the real path
    if (this.followSymlinks) {
      try {
        const realPath = await fs.realpath(resolvedPath);
        
        // Verify real path is still within bounds
        if (!realPath.startsWith(normalizedBase + path.sep) && realPath !== normalizedBase) {
          throw new Error("Symlink points outside the allowed base directory");
        }
        
        return realPath;
      } catch (error) {
        // If file doesn't exist yet, just use the resolved path
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return resolvedPath;
        }
        throw error;
      }
    }

    return resolvedPath;
  }
}
