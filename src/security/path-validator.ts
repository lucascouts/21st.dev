import * as path from "node:path";

export interface PathValidatorOptions {
  allowedBasePaths?: string[];
  followSymlinks?: boolean;
}

export interface PathValidationResult {
  valid: boolean;
  normalizedPath?: string;
  error?: string;
}

export class PathValidator {
  private allowedBasePaths: string[];
  private followSymlinks: boolean;

  constructor(options?: PathValidatorOptions) {
    this.allowedBasePaths = options?.allowedBasePaths ?? [];
    this.followSymlinks = options?.followSymlinks ?? true;
  }

  async validate(inputPath: string, basePath: string): Promise<PathValidationResult> {
    if (this.containsTraversal(inputPath)) {
      return {
        valid: false,
        error: "Path contains directory traversal sequences",
      };
    }

    try {
      const resolvedPath = await this.resolvePath(inputPath, basePath);
      const normalizedBase = path.resolve(basePath);

      if (!resolvedPath.startsWith(normalizedBase + path.sep) && resolvedPath !== normalizedBase) {
        return {
          valid: false,
          error: "Path resolves outside the allowed base directory",
        };
      }

      return { valid: true, normalizedPath: resolvedPath };
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

  private async resolvePath(inputPath: string, basePath: string): Promise<string> {
    const normalizedBase = path.resolve(basePath);
    const resolvedPath = path.resolve(normalizedBase, inputPath);

    if (this.followSymlinks) {
      try {
        const file = Bun.file(resolvedPath);
        const exists = await file.exists();
        if (exists) {
          const { realpath } = await import("node:fs/promises");
          const realPath = await realpath(resolvedPath);
          if (!realPath.startsWith(normalizedBase + path.sep) && realPath !== normalizedBase) {
            throw new Error("Symlink points outside the allowed base directory");
          }
          return realPath;
        }
        return resolvedPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return resolvedPath;
        }
        throw error;
      }
    }

    return resolvedPath;
  }
}
