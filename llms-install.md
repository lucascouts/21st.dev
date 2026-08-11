# Magic MCP Server Installation Guide

This guide is specifically designed for AI agents like Cline to install and configure the Magic MCP server.

## Prerequisites

- Bun >= 1.3.0 ([install guide](https://bun.sh/docs/installation))
- A valid TWENTY_FIRST_API_KEY from [21st.dev/magic](https://21st.dev/magic)

This package is Bun-only. Node.js is not supported: `package.json` declares
`engines.bun >= 1.3.0`, and build, test and runtime all go through Bun.

## Installation Steps

### 1. Configuration Setup

The server speaks MCP over stdio, so every client is configured the same way —
only the location of the config file changes.

#### For Kiro IDE

1. Create or modify the configuration file at `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "magic": {
      "command": "bunx",
      "args": ["@lucascouts/21st.dev@latest"],
      "env": {
        "TWENTY_FIRST_API_KEY": "<API_KEY>"
      }
    }
  }
}
```

2. Replace `<API_KEY>` with the actual TWENTY_FIRST_API_KEY value.

#### For Windsurf

1. Create or modify the configuration file at `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "magic": {
      "command": "bunx",
      "args": ["@lucascouts/21st.dev@latest"],
      "env": {
        "TWENTY_FIRST_API_KEY": "<API_KEY>"
      }
    }
  }
}
```

2. Replace `<API_KEY>` with the actual TWENTY_FIRST_API_KEY value.

#### For Cline

1. Create or modify the MCP configuration file:

```json
{
  "mcpServers": {
    "magic": {
      "command": "bunx",
      "args": ["@lucascouts/21st.dev@latest"],
      "env": {
        "TWENTY_FIRST_API_KEY": "<API_KEY>"
      }
    }
  }
}
```

2. Replace `<API_KEY>` with the actual TWENTY_FIRST_API_KEY value.

#### From a local checkout

If you built the server from source, point the client at the bundle instead:

```json
{
  "mcpServers": {
    "magic": {
      "command": "bun",
      "args": ["/path/to/magic-mcp-fork/dist/index.js"],
      "env": {
        "TWENTY_FIRST_API_KEY": "<API_KEY>"
      }
    }
  }
}
```

Build it first with `bun install && bun run build`.

### 2. Verification

To verify the installation:

1. The MCP server should appear in the list of available servers
2. Run the `magic_health_check` tool — it reports server status, version and API latency
3. Test component generation with a simple command:
   ```
   /ui create a basic button
   ```

## Troubleshooting

Common issues and solutions:

1. If the server fails to start:
   - Verify the API key is valid — the server fails fast at boot when it is missing
   - Check the Bun version: `bun --version` must be >= 1.3.0
   - Ensure all dependencies are installed (`bun install --frozen-lockfile`)

2. If components fail to generate:
   - Verify network connectivity
   - Check API key permissions
   - Ensure the command format is correct

3. To see what the server is doing, set `LOG_LEVEL=debug`. All logs go to **stderr** —
   stdout is reserved for the MCP JSON-RPC protocol.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TWENTY_FIRST_API_KEY` | Your Magic API key from 21st.dev (required) | - |
| `API_KEY` | Alternative name for the API key | - |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `MAX_FILE_SIZE` | Maximum file size for processing (bytes) | `1048576` |
| `MAX_BODY_SIZE` | Maximum callback body size (bytes) | `1048576` |
| `TWENTY_FIRST_TIMEOUT` | API request timeout (milliseconds) | `30000` |
| `DEBUG` | Enable debug mode (`true`/`false`) | `false` |

CLI arguments take precedence over environment variables (e.g. `bun dist/index.js API_KEY=...`).

## Additional Notes

- The server automatically handles TypeScript and React components
- No additional configuration is needed for basic usage
- Logos fetched by `magic_logo_search` are SVG-sanitized before being returned

## Support

If you encounter any issues:

1. Check the [FAQ section](https://21st.dev/magic/docs/faq)
2. Join our [Discord community](https://discord.gg/Qx4rFunHfm)
3. Submit an issue on [GitHub](https://github.com/lucascouts/21st.dev)

---

This installation guide is maintained by the Magic team. For updates and more information, visit [21st.dev/magic](https://21st.dev/magic).
