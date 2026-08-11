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

### Known limitations

Named deliberately, because a policy that lists only strengths is a marketing
document:

- The dependency check compares each package's **key and `name@version`** and
  discards the rest of the lockfile row. A dependency that re-resolves to the
  same version from a **different tarball** — a different `sha512` or registry
  URL, the classic re-publish or registry-tampering signal — is not detected.
- Dependabot's `bun` ecosystem provides **version updates only**; GitHub does
  not offer security updates for it. CVE detection depends entirely on the
  weekly scanner run, not on GitHub alerts.
- The API key is read from the environment or from CLI arguments. On a shared
  host, arguments are visible in the process table; prefer the environment.
