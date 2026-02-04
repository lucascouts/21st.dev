# Magic MCP (Kiro-Compatible Fork)

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

## Development

```bash
npm install
npm run build
npm run dev  # watch mode
```

## License

ISC (same as original)

## Credits

Original project by [21st.dev](https://21st.dev)
