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

| Variable | Description | Default |
|----------|-------------|---------|
| `API_KEY` | Your 21st.dev API key (required) | - |
| `TWENTY_FIRST_API_KEY` | Alternative name for API key | - |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `MAX_FILE_SIZE` | Maximum file size for processing (bytes) | `10485760` (10MB) |
| `TWENTY_FIRST_TIMEOUT` | API request timeout (milliseconds) | `30000` (30s) |
| `DEBUG` | Enable debug mode (`true`/`false`) | `false` |

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
