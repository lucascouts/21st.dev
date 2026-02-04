# Magic MCP (Kiro-Compatible Fork)

[![npm version](https://img.shields.io/npm/v/@lucascouts/21st.dev.svg)](https://www.npmjs.com/package/@lucascouts/21st.dev)
[![CI](https://github.com/lucascouts/21st.dev/actions/workflows/ci.yml/badge.svg)](https://github.com/lucascouts/21st.dev/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

Fork of [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp) with fixes for Kiro IDE compatibility.

## Changes from Original

- **Direct API calls**: Replaced browser+callback mechanism with direct API calls
- **Gemini-compatible tool names**: Renamed tools to not start with numbers
- **Reduced dependencies**: Removed `cors`, `express` (not needed); `open` kept as browser fallback
- **Better error handling**: Added fallback mechanisms and improved logging

## Tool Names

Original → Fork:
- `21st_magic_component_builder` → `magic_component_builder`
- `21st_magic_component_inspiration` → `magic_component_inspiration`
- `21st_magic_component_refiner` → `magic_component_refiner`
- `logo_search` → `magic_logo_search`

## Installation

### Kiro IDE

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "magic": {
      "command": "node",
      "args": ["/path/to/magic-mcp-fork/dist/index.js"],
      "env": {
        "API_KEY": "your-21st-dev-api-key"
      }
    }
  }
}
```

### From NPM (after publishing)

```json
{
  "mcpServers": {
    "magic": {
      "command": "npx",
      "args": ["-y", "@lucascouts/21st-dev-kiro@latest"],
      "env": {
        "API_KEY": "your-21st-dev-api-key"
      }
    }
  }
}
```

## Get API Key

1. Go to [21st.dev](https://21st.dev)
2. Sign up / Sign in
3. Navigate to settings to get your API key

## Environment Variables

### Configuration Priority

Magic MCP resolves configuration values in the following priority order (highest to lowest):

1. **CLI Arguments** - Command-line flags and arguments passed when starting the server
2. **Environment Variables** - Values set in your shell or MCP configuration
3. **Defaults** - Built-in default values

Example: If you set `API_KEY` both as an environment variable and as a CLI argument, the CLI argument value will be used.

### Available Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `API_KEY` | Your 21st.dev API key | - | Yes |
| `TWENTY_FIRST_API_KEY` | Alternative name for API key | - | No |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` | No |
| `MAX_FILE_SIZE` | Maximum file size for processing (bytes) | `10485760` (10MB) | No |
| `TWENTY_FIRST_TIMEOUT` | API request timeout (milliseconds) | `30000` (30s) | No |
| `DEBUG` | Enable debug mode (`true`/`false`) | `false` | No |
| `CACHE_TTL` | Cache entry time-to-live (seconds) | `300` (5 min) | No |
| `MAX_BODY_SIZE` | Maximum request body size (bytes) | `1048576` (1MB) | No |

### CLI Arguments

You can also pass configuration via command-line arguments:

```bash
# API Key
node dist/index.js API_KEY=your-key
node dist/index.js --API_KEY=your-key

# Feature flags
node dist/index.js --canvas
node dist/index.js --github
```

**Note:** CLI arguments take precedence over environment variables.

## Development

### With Bun (Recommended)

```bash
bun install
bun run build
bun test
bun run dev  # watch mode
```

### With Node.js

```bash
npm install
npm run build:node
npm run start:node
```

## License

ISC (same as original)

## Credits

Original project by [21st.dev](https://21st.dev)
