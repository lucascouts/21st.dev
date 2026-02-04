# Magic MCP Server Installation Guide

This guide is specifically designed for AI agents like Cline to install and configure the Magic MCP server.

## Prerequisites

**Option A: Bun (Recommended)**
- Bun >= 1.0.0 ([install guide](https://bun.sh/docs/installation))
- A valid TWENTY_FIRST_API_KEY from [21st.dev/magic](https://21st.dev/magic)

**Option B: Node.js**
- Node.js >= 18.0.0 (LTS version recommended)
- A valid TWENTY_FIRST_API_KEY from [21st.dev/magic](https://21st.dev/magic)

## Installation Steps

### 1. Configuration Setup

The Magic MCP server requires configuration based on the client type. Below are the setup instructions for each supported client:

#### For Kiro IDE (Bun)

1. Create or modify the configuration file at `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "magic": {
      "command": "bun",
      "args": ["x", "@lucascouts/21st.dev@latest"],
      "env": {
        "TWENTY_FIRST_API_KEY": "<API_KEY>"
      }
    }
  }
}
```

2. Replace `<API_KEY>` with the actual TWENTY_FIRST_API_KEY value.

#### For Kiro IDE (Node.js)

1. Create or modify the configuration file at `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "magic": {
      "command": "npx",
      "args": ["-y", "@lucascouts/21st.dev@latest"],
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
      "command": "npx",
      "args": [
        "-y",
        "@smithery/cli@latest",
        "install",
        "@21st-dev/magic-mcp",
        "--client",
        "windsurf"
      ],
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
    "@21st-dev-magic-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@smithery/cli@latest",
        "run",
        "@21st-dev/magic-mcp",
        "--config",
        "\"{\\\"TWENTY_FIRST_API_KEY\\\":\\\"<API_KEY>\\\"}\""
      ]
    }
  }
}
```

2. Replace `<API_KEY>` with the actual TWENTY_FIRST_API_KEY value.

### 2. Verification

To verify the installation:

1. The MCP server should appear in the list of available servers
2. Test the connection by sending a simple command:
   ```
   /ui create a basic button
   ```

## Troubleshooting

Common issues and solutions:

1. If the server fails to start:
   - Verify the API key is valid
   - Check runtime version (Bun >= 1.0.0 or Node.js >= 18.0.0)
   - Ensure all dependencies are installed

2. If components fail to generate:
   - Verify network connectivity
   - Check API key permissions
   - Ensure the command format is correct

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TWENTY_FIRST_API_KEY` | Your Magic API key from 21st.dev (required) | - |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `MAX_FILE_SIZE` | Maximum file size for processing (bytes) | `10485760` |
| `TWENTY_FIRST_TIMEOUT` | API request timeout (milliseconds) | `30000` |
| `DEBUG` | Enable debug mode (`true`/`false`) | `false` |

## Additional Notes

- The server automatically handles TypeScript and React components
- No additional configuration is needed for basic usage
- The server supports hot reloading for development
- Bun runtime provides faster startup and execution

## Support

If you encounter any issues:

1. Check the [FAQ section](https://21st.dev/magic/docs/faq)
2. Join our [Discord community](https://discord.gg/Qx4rFunHfm)
3. Submit an issue on [GitHub](https://github.com/serafimcloud/21st)

---

This installation guide is maintained by the Magic team. For updates and more information, visit [21st.dev/magic](https://21st.dev/magic).
