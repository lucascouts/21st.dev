import { z } from "zod";

const LogLevelEnum = z.enum(["debug", "info", "warn", "error"]);

const ConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  logLevel: LogLevelEnum.default("info"),
  timeout: z.number().int().positive().default(30_000),
  maxFileSize: z.number().int().positive().default(1_048_576),
  maxBodySize: z.number().int().positive().default(1_048_576),
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
        break;
      }
    }
  }

  return result;
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
    debug:
      (cli.debug as boolean) ?? process.env.DEBUG === "true",
    canvas: (cli.canvas as boolean) ?? false,
    github: (cli.github as boolean) ?? false,
  };

  const parsed = ConfigSchema.parse(raw);
  return Object.freeze(parsed);
}
