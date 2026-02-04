# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
