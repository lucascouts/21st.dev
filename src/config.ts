import * as path from "node:path";
import { z } from "zod";

const LogLevelEnum = z.enum(["debug", "info", "warn", "error"]);

/**
 * One directory that a caller-supplied path may be confined to.
 *
 * Resolved here rather than at each use, so a relative root cannot be
 * interpreted as two different directories in two places.
 *
 * The filesystem root is refused on the RESOLVED value, not on the raw string:
 * `path.resolve("/..")` is `"/"`, so a check against the literal `"/"` lets it
 * back in. A base of `"/"` confines nothing, which is the defect this field
 * exists to remove. `path.parse(root).root === root` is true exactly for `/`
 * and for a Windows drive root.
 */
const AllowedRootSchema = z
  .string()
  .min(1, "An allowed root must not be empty")
  .transform((root) => path.resolve(root))
  .refine((root) => path.parse(root).root !== root, {
    message: "The filesystem root is not a valid allowed root",
  });

const ConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  logLevel: LogLevelEnum.default("info"),
  timeout: z.number().int().positive().default(30_000),
  maxFileSize: z.number().int().positive().default(1_048_576),
  maxBodySize: z.number().int().positive().default(1_048_576),
  allowedRoots: z.array(AllowedRootSchema).nonempty().default([process.cwd()]),
  debug: z.boolean().default(false),
  canvas: z.boolean().default(false),
  github: z.boolean().default(false),
});

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

function parseCliArgs(): Partial<Record<string, string | boolean>> {
  const result: Partial<Record<string, string | boolean>> = {};

  for (const arg of process.argv) {
    if (arg === "--canvas") {
      result.canvas = true;
      continue;
    }
    if (arg === "--github") {
      result.github = true;
      continue;
    }
    if (arg === "--debug") {
      result.debug = true;
      continue;
    }

    const patterns = [
      /^([A-Z_]+)=(.+)$/,
      /^--([A-Z_]+)=(.+)$/,
      /^\/([A-Z_]+):(.+)$/,
      /^-([A-Z_]+)[ =](.+)$/,
    ];

    for (const pattern of patterns) {
      const match = arg.match(pattern);
      if (match) {
        const [, key, value] = match;
        const cleanValue = value.replaceAll('"', "").replaceAll("'", "");
        if (key === "API_KEY") result.apiKey = cleanValue;
        if (key === "LOG_LEVEL") result.logLevel = cleanValue;
        if (key === "TIMEOUT") result.timeout = cleanValue;
        if (key === "MAX_FILE_SIZE") result.maxFileSize = cleanValue;
        if (key === "MAX_BODY_SIZE") result.maxBodySize = cleanValue;
        if (key === "ALLOWED_ROOTS") result.allowedRoots = cleanValue;
        break;
      }
    }
  }

  return result;
}

/**
 * `ALLOWED_ROOTS` is a `path.delimiter`-separated list — `:` on POSIX, `;` on
 * Windows — the same convention `PATH` uses, and the only one that stays
 * correct on both platforms.
 *
 * An ABSENT value means "use the default" and never reaches here. An explicitly
 * EMPTY one splits to `[""]`, which the schema refuses: silently widening a
 * security boundary on an empty string is how the original defect reads.
 */
function splitRoots(value: string): string[] {
  return value.split(path.delimiter);
}

export function parseConfig(): Config {
  const cli = parseCliArgs();

  const raw = {
    apiKey:
      (cli.apiKey as string) ??
      process.env.TWENTY_FIRST_API_KEY ??
      process.env.API_KEY ??
      "",
    logLevel:
      (cli.logLevel as string) ?? process.env.LOG_LEVEL ?? "info",
    timeout:
      cli.timeout != null
        ? Number(cli.timeout)
        : process.env.TWENTY_FIRST_TIMEOUT != null
          ? Number(process.env.TWENTY_FIRST_TIMEOUT)
          : 30_000,
    maxFileSize:
      cli.maxFileSize != null
        ? Number(cli.maxFileSize)
        : process.env.MAX_FILE_SIZE != null
          ? Number(process.env.MAX_FILE_SIZE)
          : 1_048_576,
    maxBodySize:
      cli.maxBodySize != null
        ? Number(cli.maxBodySize)
        : process.env.MAX_BODY_SIZE != null
          ? Number(process.env.MAX_BODY_SIZE)
          : 1_048_576,
    // The default is routed through `raw` rather than the schema's `.default()`,
    // which zod 4.4.3 short-circuits: a schema default skips parsing, so it would
    // reach callers unresolved and unchecked. Here it is checked like any other
    // value, and a working directory of `/` fails loudly instead of yielding `["/"]`.
    allowedRoots:
      cli.allowedRoots != null
        ? splitRoots(cli.allowedRoots as string)
        : process.env.ALLOWED_ROOTS != null
          ? splitRoots(process.env.ALLOWED_ROOTS)
          : [process.cwd()],
    debug:
      (cli.debug as boolean) ?? process.env.DEBUG === "true",
    canvas: (cli.canvas as boolean) ?? false,
    github: (cli.github as boolean) ?? false,
  };

  const parsed = ConfigSchema.parse(raw);
  return Object.freeze(parsed);
}
