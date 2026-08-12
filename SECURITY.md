# Security Policy

## Reporting a vulnerability

**Use [GitHub's private vulnerability reporting](https://github.com/lucascouts/21st.dev/security/advisories/new)** — not a public issue, and not the
issue tracker. That channel is private until an advisory is published, so a
report cannot disclose the problem while it is still exploitable.

Please include what you were running (package version, Bun version), what you
observed, and the smallest reproduction you have. A proof of concept is welcome
but never required — a clear description of the mechanism is enough.

### Fork or upstream?

This package is a fork of [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp), and the two have diverged. Sending a
report to the wrong repository costs you a round trip, so:

| Where the problem lives | Report to |
|---|---|
| The direct-API call path that replaced the browser + callback mechanism | **here** |
| SVG handling in `magic_logo_search` | **here** |
| Configuration, argument parsing, or the server bootstrap | **here** |
| Anything reproducible on upstream `21st-dev/magic-mcp` at the same version | [upstream](https://github.com/21st-dev/magic-mcp/security) |
| The 21st.dev API or web service itself | [21st.dev](https://21st.dev) |

If you are unsure, report it here and say so — misrouting it in good faith is
better than not reporting it, and forwarding is our job, not yours.

### What to expect

This project is maintained by one person, so **no response time is promised**.
A policy that pledges a deadline nobody enforces is worse than an honest one:
you would calibrate against a number that does not exist. What is committed to
is that reports are read, that credible ones are acted on, and that you are
told the outcome either way.

Reporters are credited in the published advisory unless they ask not to be.

## Supported versions

| Version | Supported |
|---|---|
| 2.x | ✓ |
| < 2.0 | ✗ — the 2.0 refactor replaced the transport, the tool names and the dependency set; there is no patch path back |

Fixes ship on the `main` branch and are published to npm as
`@lucascouts/21st.dev`. There is no long-term support branch.

## Security posture

Stated so a reader can judge what is already covered and where a finding would
be genuinely new, rather than guessing:

- **Two runtime dependencies**, `@modelcontextprotocol/sdk` and `zod`. `cors`,
  `express`, `open`, `esbuild` and `shx` were all removed. Every dependency not
  present is an attack surface that does not exist.
- **A 7-day release-age cooldown** on installs (`install.minimumReleaseAge` in
  `bunfig.toml`), mirrored in `.github/dependabot.yml`. A package published in
  the last week is not installed, which is the window in which a compromised
  release is typically caught and pulled.
- **Committed lockfile, frozen installs.** CI runs `bun install --frozen-lockfile`;
  an npm lockfile is never committed, so there is one resolution source.
- **Workflow actions pinned by commit SHA**, never by mutable tag, with the
  default token restricted to `contents: read`.
- **A weekly dependency check** (`scripts/dep-check.sh`) that runs `osv-scanner`
  and `trivy` over the resolved tree, and independently re-resolves the lockfile
  to report drift in both directions — packages whose versions moved, and keys
  present in only one of the two lockfiles.
- **No network access in the test suite**, verified under a network namespace
  with no egress.
- **Remote SVG is sanitized by parsing, not by pattern matching.** Fetched markup
  is parsed with Bun's native `HTMLRewriter` and re-emitted from an explicit
  allowlist of elements and attributes; anything not named is removed. An
  allowlist can be reviewed, which is the property a denylist cannot offer. The
  sanitizer is total and fails closed: a parser error yields empty output, never
  the input.
- **The follow-up SVG fetch is restricted by scheme and address range.** Only
  `https` is issued, and never to a loopback name or to an IP literal in a
  loopback, link-local, private or reserved range. Redirects are followed
  manually with the same check applied to every hop, so the restriction governs
  the request that leaves the process rather than the URL as written.
- **The logo API response is validated before any field is read**, against a
  schema describing only the fields actually consumed.
- **Every remote response is validated, not cast.** The shared HTTP client takes
  a required schema and returns a discriminated result whose failure branch
  carries no data at all, so a body that did not satisfy its schema cannot reach
  a caller. There is no overload without a schema: the unsafe call is not
  expressible rather than merely discouraged.
- **No remote-supplied text reaches the MCP client.** A failure is reported by a
  name drawn from a closed set of seven, each mapped to a constant message with
  no interpolation slot. A response body, an error message, a `statusText` and a
  remote-chosen hostname all stop at the boundary; the detail goes to the local
  log. Redaction of credential-shaped substrings was considered and rejected — a
  denylist is narrower than the requirement exactly where nobody anticipated.
- **Response bodies are size-bounded** against both the declared `content-length`
  and the bytes actually accumulated, since the former is remote-supplied. The
  request deadline covers the body read, not only the headers.
- **Redirects may not leave the configured service origin**, checked on every hop.
- **Tool file access is confined to a configured set of roots**, defaulting to the
  working directory. The filesystem root can neither be configured nor passed to
  the validator, and a refused path is reported to the caller and logged.
- **The browser callback requires an `Origin` the allowlist accepts** — absence is
  not permission — admits localhost only when explicitly opted in, and validates
  the body against a schema before it can resolve anything. See the limitation
  below for what this does and does not amount to.
- **Every tool is executed through a real MCP client in the test suite**, not only
  described in a `tools/list` contract check.

### Known limitations

Named deliberately, because a policy that lists only strengths is a marketing
document. The first group concerns the logo pipeline specifically:

- **DNS rebinding is not defended against.** The host restriction examines the
  URL as written. A hostname that passes the check and resolves to a private
  address at connect time defeats it. Closing this requires resolving the name,
  pinning the address and connecting to the pinned address, which `fetch` does
  not expose.
- **The `style` attribute is the weakest point of the sanitizer's allowlist.** It
  is admitted because it appears in most real logos, and its value is checked by
  allowlisting CSS property names and requiring every `url(...)` to be a
  same-document fragment. The value side is otherwise unvalidated. Being certain
  would need a CSS parser, which would breach the two-dependency posture above.
- **`href` and `xlink:href` admit `https` URLs**, so a logo can reference an
  external resource on `use`, `pattern` or `mask`. That is an outbound fetch from
  whoever renders the logo — a tracking beacon, not code execution. Restricting
  these to same-document fragments would close it and is a deliberate open
  decision, not an oversight.
- **NAT64 (`64:ff9b::/96`) is not treated as an embedded IPv4 address.** It
  denotes one only through a translating gateway, and RFC 6052 permits
  network-specific prefixes that no static list can enumerate; blocking only the
  well-known prefix would claim a coverage it cannot deliver.
The next group concerns the browser callback:

- **The callback is constrained by origin. It is not authenticated.** A request
  must now carry an `Origin` the allowlist accepts, and its body must satisfy a
  schema before it resolves anything — but any local process can set that header.
  A process already executing as the user can therefore still answer the
  callback. Authenticating it would need a secret echoed back by the page at
  `21st.dev`: the outbound URL carries only `q`, `mcp` and `port`, and that page
  builds the callback URL itself, so a nonce cannot be introduced from this side
  alone. Requiring one unilaterally would refuse every legitimate callback, and
  sending one while accepting its absence would be a check whose population does
  not cover its requirement — which is the defect class this project keeps
  finding. Stated as an open decision, not an oversight.
- **A failed tool call leaves its loopback callback port bound** for the lifetime
  of the process, because the server is constructed inside the `try` its own
  error handler cannot reach. The port refuses everything the constraints above
  refuse, and its waiter is already settled, so this is a resource leak on a
  security-relevant surface rather than a way in. Measured.

Two concern the local log rather than anything a caller sees:

- **`LogSanitizer` does not redact a credential inside a JSON-serialized
  object.** Its pattern requires the start of the string, whitespace, `=` or `:`
  before the value, and JSON puts a `"` there, so `{"apiKey":"api_…"}` survives.
  This applies to every object any call site logs. Measured.
- **A URL carrying credentials in its userinfo can reach the log** through a
  connection error's own `path` property. The URL guard checks scheme and host,
  not userinfo. Nothing of this reaches a caller — remote text no longer crosses
  that boundary at all — but it does reach the operator's log.

The rest concern the supply chain:

- The dependency check compares each package's **key and `name@version`** and
  discards the rest of the lockfile row. A dependency that re-resolves to the
  same version from a **different tarball** — a different `sha512` or registry
  URL, the classic re-publish or registry-tampering signal — is not detected.
- Dependabot's `bun` ecosystem provides **version updates only**; GitHub does
  not offer security updates for it. CVE detection depends entirely on the
  weekly scanner run, not on GitHub alerts.
- The API key is read from the environment or from CLI arguments. On a shared
  host, arguments are visible in the process table; prefer the environment.
