# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-08-10

Full architectural refactor. **Breaking**: this release is Bun-only and drops every
Node.js entry point.

### Added

- Immutable configuration: parsed once at boot, Zod-validated, `Object.freeze()`d and
  distributed by dependency injection (`src/config.ts`)
- SVG sanitizer (`src/http/svg-sanitizer.ts`) — strips `<script>`, event handlers,
  `<foreignObject>`, `javascript:` URIs and external-content elements from fetched logos
- `degraded` health state (latency > 2000ms) reported by `magic_health_check`
- Pool-based concurrency in logo search — slots refill as soon as they free up, instead of
  waiting for a whole chunk to finish
- `unhandledRejection` handler and explicit graceful shutdown
- Property-based tests for log sanitization and SVG sanitization
- `typecheck` script (`tsc --noEmit`), now also enforced in CI

### Changed

- **Runtime is Bun-only** (`engines.bun >= 1.3.0`); `bun build` replaces esbuild
- Source reorganized by domain: `tools/`, `http/`, `callback/`, `security/`, `browser/`,
  with tests mirroring the tree under `src/__tests__/`
- All components receive their dependencies via constructor — no global singletons
- `BaseTool` is now generic over its schema (`z.ZodObject<z.ZodRawShape>`), replacing `any`
- HTTP retries use a fresh `AbortController` per attempt, so the timeout is per-attempt
  rather than shared across the whole retry chain; JSON parsing is failure-safe
- `CallbackServer` is a disposable single-use instance on an ephemeral port (`port: 0`),
  replacing the singleton with its IDLE/BUSY/SHUTDOWN state machine
- `BrowserDetector` uses static imports and is instantiated with an injected logger
- All logs go to **stderr** — `console.log` would corrupt the MCP JSON-RPC stream on stdout
- Shutdown sets `process.exitCode` instead of calling `process.exit()`, so logs can flush
- CI runs a single Bun job with actions pinned by commit SHA

### Removed

- **Node.js support**: `build:node` / `start:node` scripts and the Node CI job
- Dependencies: `esbuild`, `shx`, `open`, `@types/node`
- `SessionTokenManager` — dead code, since 21st.dev does not support a token in the callback
- API response cache (`ApiCache`) and the `CACHE_TTL` variable
- `src/utils/` (`console.ts`, `get-content-of-file.ts`, `session-token.ts`)
- `beforeExit` handler, which risked an exit loop

### Fixed

- `MAX_FILE_SIZE` documented default corrected to 1MB (it was documented as 10MB)
- README no longer documents removed Node.js scripts
- **The Docker build works again.** `bun install` at the builder stage ran the root package's
  `prepare` script — `bun run build` — before `COPY . .` had brought `src/` into the image, so
  the build died on `FileNotFound opening root directory "src"`. The install now passes
  `--ignore-scripts`; the real build still runs on the next line, once the sources are there.
  Skipping install scripts is also the standard defense against a malicious `postinstall`, and
  costs nothing here — no dependency in the tree declares one.

### Security

- **11 transitive CVEs remediated**, by bumping `@modelcontextprotocol/sdk` to `^1.30.0`
  and re-resolving the lockfile. Affected packages: `hono`, `@hono/node-server`,
  `fast-uri`, `ip-address`, `body-parser`. The vulnerable code paths sit in the SDK's HTTP
  transport, which a stdio server never loads — the exposure was latent rather than
  reachable, but it is now closed either way.
- **Release-age quarantine** — `bunfig.toml` sets `install.minimumReleaseAge = 604800`, so
  a version published less than seven days ago is never resolved. A compromised publish has
  to survive a week of public scrutiny before it can reach this project. It is a rolling
  quarantine, not a version pin.
- **Weekly dependency check** — `scripts/dep-check.sh` reports what a re-resolution would
  change and scans the resolved tree with `osv-scanner` and `trivy`, emitting one JSON event
  per line. It writes nothing, needs no credentials and contacts no hosted service, and it
  exits non-zero both on findings and on a scanner it could not run — a skipped scan never
  reads as a clean one. Optional systemd user units in `contrib/systemd/` run it weekly.
  The quarantine gates what enters the tree; this catches what has aged in place.
- **Bun floor raised to 1.3.0**, in both `engines.bun` and both `Dockerfile` stages. 1.3.0
  is the first release that honors `install.minimumReleaseAge`; every 1.2.x accepts the key
  in silence and applies no cooldown at all, so the previous `>=1.2.0` promised a guarantee
  the runtime did not deliver.
- **Tool-contract guard** — `src/__tests__/server/tool-contract.test.ts` drives a real MCP
  client over an in-memory transport and pins the six advertised tool names plus each input
  schema's property names, required set and declared types. A future SDK bump cannot change
  the wire contract without failing the suite. Description text is deliberately left
  unpinned, so wording stays free to improve.

## [1.1.0] - 2026-02-04

### Added

#### Security
- Session token validation for callback requests (CSRF/replay attack prevention)
- Request body size limits (default 1MB, configurable via MAX_BODY_SIZE)
- Log sanitization for API keys, tokens, and sensitive headers
- SessionTokenManager for cryptographic token generation and validation

#### Performance
- API response caching with LRU eviction (default 100 entries, 5min TTL)
- Parallel SVG fetching in logo search (concurrency limit: 5)
- Callback server singleton pattern for reuse across tool calls
- ApiCache utility with configurable TTL and statistics tracking

#### Architecture
- BrowserDetector module extracted from CreateUiTool
- Standardized error response format across all tools
- Health check tool (`magic_health_check`) for monitoring server status
- Configuration documentation with priority order (CLI > Env > Defaults)

#### Testing
- Property-based tests for session token uniqueness (Property A1)
- Property-based tests for log redaction completeness (Property A4)
- Property-based tests for cache hit determinism (Property B1)
- Property-based tests for error format consistency (Property C1)
- Property-based tests for parallel fetch independence (Property B3)
- Comprehensive unit tests for all new utilities

### Changed

- BaseTool enhanced with `formatError()` and `generateErrorCode()` methods
- All tools updated to use standardized error responses
- CreateUiTool refactored to use BrowserDetector module
- LogoSearchTool updated with parallel fetching and partial failure handling
- CallbackServer enhanced with session tokens and body size limits
- Logger integrated with LogSanitizer for automatic redaction

### Security

- All callback requests now require valid session tokens
- Request bodies limited to prevent DoS attacks
- Sensitive data automatically redacted from logs
- API keys, tokens, and credentials protected in all log output

### Performance

- Repeated API requests served from cache (up to 5min TTL)
- Logo searches complete faster with parallel SVG fetching
- Callback server reuse reduces port allocation overhead
- Cache hit rates tracked for monitoring

## [1.0.0] - 2026-02-04

### Added

- Bun as primary runtime for faster builds and tests
- CI/CD with GitHub Actions (Bun + Node.js)
- Unit tests for `fetch-ui` and `refine-ui` tools
- Environment variable documentation (LOG_LEVEL, MAX_FILE_SIZE, TWENTY_FIRST_TIMEOUT, DEBUG)
- Node.js fallback scripts (`build:node`, `start:node`)
- Multi-stage Dockerfile for optimized container builds

### Changed

- Migrated from Jest to Bun's native test runner
- Updated Dockerfile to use `oven/bun:1` base image
- Simplified package.json scripts for Bun-first workflow
- Improved README with badges and clearer documentation

### Removed

- Jest, ts-jest, and @types/jest dependencies
- jest.config.js configuration file

### Fixed

- Version standardization (was 0.2.0 in index.ts, now 1.0.0)
- README clarification: `open` package is still used as browser fallback (not removed)

## Changes from Original Fork

This is a fork of [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp) with the following modifications:

- **Direct API calls**: Replaced browser+callback mechanism with direct API calls
- **Gemini-compatible tool names**: Renamed tools to not start with numbers
- **Reduced dependencies**: Removed `cors`, `express` (not needed); `open` kept as browser fallback
- **Better error handling**: Added fallback mechanisms and improved logging
- **Security improvements**: Added rate limiting, path validation, shell sanitization
- **Kiro IDE compatibility**: Full support for Kiro IDE MCP configuration
