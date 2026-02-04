import * as fs from "fs/promises";
import * as nodePath from "path";
import { PathValidator } from "./path-validator.js";
import { logger } from "./logger.js";

export interface FileReaderOptions {
  maxSize?: number;
  basePath?: string;
  validatePath?: boolean;
}

const DEFAULT_MAX_SIZE = 1024 * 1024; // 1MB

/**
 * Get the maximum file size limit from environment or default.
 * Requirements: 8.1, 8.2
 */
function getMaxFileSize(options?: FileReaderOptions): number {
  if (options?.maxSize !== undefined) {
    return options.maxSize;
  }
  
  const envMaxSize = process.env.MAX_FILE_SIZE;
  if (envMaxSize) {
    const parsed = parseInt(envMaxSize, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  
  return DEFAULT_MAX_SIZE;
}

/**
 * Reads file content with path validation and size limits.
 * 
 * Requirements:
 * - 2.1, 2.2, 2.3, 2.4, 2.5: Path traversal prevention
 * - 8.1, 8.2, 8.3, 8.4: File size limits
 * 
 * @param path - The file path to read
 * @param options - Optional configuration for validation and size limits
 * @returns File content as string, or empty string on error
 */
export async function getContentOfFile(
  path: string,
  options?: FileReaderOptions
): Promise<string> {
  const shouldValidatePath = options?.validatePath !== false;
  const basePath = options?.basePath ?? process.cwd();
  const maxSize = getMaxFileSize(options);

  try {
    // Path validation (Requirements 2.1, 2.2, 2.3, 2.4)
    if (shouldValidatePath) {
      const validator = new PathValidator();
      const validationResult = await validator.validate(path, basePath);
      
      if (!validationResult.valid) {
        logger.warn(`Path validation failed for "${path}": ${validationResult.error}`);
        return "";
      }
      
      // Use the normalized path for reading
      path = validationResult.normalizedPath!;
    } else {
      // Even without validation, resolve the path
      path = nodePath.resolve(basePath, path);
    }

    // File size check (Requirements 8.1, 8.2, 8.3, 8.4)
    const stats = await fs.stat(path);
    if (stats.size > maxSize) {
      logger.warn(`File size limit exceeded for "${path}": ${stats.size} bytes (limit: ${maxSize} bytes)`);
      return "";
    }

    return await fs.readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug(`File not found: ${path}`);
    } else if ((error as NodeJS.ErrnoException).code === "EACCES") {
      logger.error(`Permission denied reading file: ${path}`);
    } else {
      logger.error(`Error reading file ${path}:`, error);
    }
    return "";
  }
}
