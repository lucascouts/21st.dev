/**
 * Configuration interface for Magic MCP server
 */
export interface Config {
  apiKey?: string;
  canvas?: boolean;
  github?: boolean;
}

/**
 * Parse command-line arguments to extract configuration values.
 * 
 * **Configuration Priority Order:**
 * 1. CLI arguments (highest priority)
 * 2. Environment variables
 * 3. Defaults (lowest priority)
 * 
 * @returns Parsed configuration from CLI arguments
 */
const parseArguments = (): Config => {
  const config: Config = {};

  // Command line arguments override environment variables
  process.argv.forEach((arg) => {
    // Check for --canvas flag
    if (arg === "--canvas") {
      config.canvas = true;
      return;
    }

    // Check for --github flag
    if (arg === "--github") {
      config.github = true;
      return;
    }

    const keyValuePatterns = [
      /^([A-Z_]+)=(.+)$/, // API_KEY=value format
      /^--([A-Z_]+)=(.+)$/, // --API_KEY=value format
      /^\/([A-Z_]+):(.+)$/, // /API_KEY:value format (Windows style)
      /^-([A-Z_]+)[ =](.+)$/, // -API_KEY value or -API_KEY=value format
    ];

    for (const pattern of keyValuePatterns) {
      const match = arg.match(pattern);
      if (match) {
        const [, key, value] = match;
        if (key === "API_KEY") {
          // Strip surrounding quotes from the value
          const cleanValue = value.replaceAll('"', "").replaceAll("'", "");
          config.apiKey = cleanValue;
          break;
        }
      }
    }
  });

  return config;
};

/**
 * Get the effective configuration with all resolved values.
 * 
 * Returns the final configuration after applying the priority order:
 * CLI arguments > Environment variables > Defaults
 * 
 * @returns Complete configuration with all resolved values
 */
export const getEffectiveConfig = (): Required<Config> & Record<string, unknown> => {
  const cliConfig = parseArguments();
  
  return {
    // API Key: CLI > TWENTY_FIRST_API_KEY env > API_KEY env > undefined
    apiKey: cliConfig.apiKey || process.env.TWENTY_FIRST_API_KEY || process.env.API_KEY || "",
    
    // Canvas flag: CLI > false (default)
    canvas: cliConfig.canvas ?? false,
    
    // GitHub flag: CLI > false (default)
    github: cliConfig.github ?? false,
    
    // Additional environment variables (not in Config interface but available)
    logLevel: process.env.LOG_LEVEL || "info",
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "10485760", 10),
    timeout: parseInt(process.env.TWENTY_FIRST_TIMEOUT || "30000", 10),
    debug: process.env.DEBUG === "true",
  };
};

export const config = parseArguments();
