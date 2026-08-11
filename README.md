# Magic MCP (Kiro-Compatible Fork)

[![npm version](https://img.shields.io/npm/v/@lucascouts/21st.dev.svg)](https://www.npmjs.com/package/@lucascouts/21st.dev)
[![CI](https://github.com/lucascouts/21st.dev/actions/workflows/ci.yml/badge.svg)](https://github.com/lucascouts/21st.dev/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

Fork of [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp) with fixes for Kiro IDE compatibility.

## Requirements

Bun >= 1.3.0. This project is Bun-only: build, test and runtime all go through Bun.

## Changes from Original

- **Direct API calls**: Replaced browser+callback mechanism with direct API calls
- **Gemini-compatible tool names**: Renamed tools to not start with numbers
- **Minimal dependencies**: Only `@modelcontextprotocol/sdk` and `zod` at runtime — `cors`,
  `express`, `open`, `esbuild` and `shx` were all dropped
- **Better error handling**: Added fallback mechanisms and improved logging

## Tools

| Tool | Purpose |
|------|---------|
| `magic_component_builder` | Generate a new UI component |
| `magic_component_inspiration` | Fetch component inspiration |
| `magic_component_refiner` | Refine an existing component |
| `magic_component_canvas` | Open the component canvas |
| `magic_logo_search` | Search and fetch logos (SVG sanitized) |
| `magic_health_check` | Report server health and latency |

Renamed from the original fork:

- `21st_magic_component_builder` → `magic_component_builder`
- `21st_magic_component_inspiration` → `magic_component_inspiration`
- `21st_magic_component_refiner` → `magic_component_refiner`
- `logo_search` → `magic_logo_search`

## Tool Naming Convention

This fork uses `magic_*` prefixed tool names (e.g., `magic_component_builder`, `magic_logo_search`) instead of the original `21st_magic_*` prefix. This was a deliberate choice for Gemini compatibility, as Gemini does not support tool names starting with numbers.

## Installation

### Kiro IDE

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "magic": {
      "command": "bun",
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
      "command": "bunx",
      "args": ["@lucascouts/21st.dev@latest"],
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
| `MAX_FILE_SIZE` | Maximum file size for processing (bytes) | `1048576` (1MB) | No |
| `TWENTY_FIRST_TIMEOUT` | API request timeout (milliseconds) | `30000` (30s) | No |
| `MAX_BODY_SIZE` | Maximum callback body size (bytes) | `1048576` (1MB) | No |
| `DEBUG` | Enable debug mode (`true`/`false`) | `false` | No |

If no API key is provided, the server fails fast at boot instead of starting in a
broken state.

### CLI Arguments

You can also pass configuration via command-line arguments:

```bash
# API Key
bun dist/index.js API_KEY=your-key
bun dist/index.js --API_KEY=your-key

# Feature flags
bun dist/index.js --canvas
bun dist/index.js --github
bun dist/index.js --debug
```

**Note:** CLI arguments take precedence over environment variables.

## Development

```bash
bun install           # install dependencies
bun run typecheck     # tsc --noEmit
bun test              # unit + property-based tests
bun run build         # bundle to dist/
bun run dev           # watch mode
```

## License

ISC (same as original)

## Credits

Original project by [21st.dev](https://21st.dev)
