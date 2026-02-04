# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
