/**
 * The vocabulary a failed remote call is reported in (R2.1, R2.2, R2.3).
 *
 * Two audiences, two strings, one file. The MCP client is told a NAME from a
 * closed set and a CONSTANT message; the local log is told what actually
 * happened, remote text included. Keeping both halves here is the point: at a
 * call site the two are one `catch` apart, and that is where a remote
 * `statusText` ends up in the sentence handed to the user — the defect story 005
 * measured and deferred.
 *
 * The client-facing message is a constant, never a template. A message with no
 * slot in it has nowhere for remote text to be placed, however the call site is
 * later rewritten, which turns "no remote text crosses" into something a test
 * asserts by string containment rather than something a reviewer argues about.
 * Redaction — forwarding remote text with credential-shaped substrings removed —
 * was considered and rejected in design.md: it is a denylist, and a denylist is
 * narrower than the requirement exactly where nobody anticipated.
 */

/**
 * The closed set. This list is the single source of truth: `FailureKind` is
 * derived from it, so a member added here without a message fails
 * `bun run typecheck` at `FAILURE_MESSAGES` rather than at some call site later.
 */
export const FAILURE_KINDS = [
  "network",
  "timeout",
  "http_error",
  "unreadable_body",
  "schema_mismatch",
  "too_large",
  "redirect_refused",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * What the MCP client is told, and all it is told.
 *
 * Every value is prose with no interpolation slot of any form — no `${…}`, no
 * printf verb, no `{placeholder}`. Each is also distinct from the others, so the
 * kinds stay distinguishable to a caller that only sees the message.
 *
 * `as const satisfies` rather than a plain `Record` annotation: `satisfies`
 * still rejects a missing or unknown key, while `as const` keeps the properties
 * readonly, which is what a module named for constants should guarantee.
 */
export const FAILURE_MESSAGES = {
  network: "the connection could not be made",
  timeout: "the request timed out",
  http_error: "the service returned an error status",
  unreadable_body: "the response could not be read",
  schema_mismatch: "the response did not match the expected shape",
  too_large: "the response exceeded the size limit",
  redirect_refused: "the request was redirected outside the service",
} as const satisfies Record<FailureKind, string>;

/**
 * The other half of the split: the line written to the local log at `error`, so
 * failing closed does not also mean failing silently (R2.3).
 *
 * `detail` is the caller's local knowledge, and it MAY carry remote text — that
 * is the half that must not be withheld. design.md fixes what each kind is
 * expected to pass, and the call site is what honours it:
 *
 * | kind               | detail to pass                                  |
 * |--------------------|-------------------------------------------------|
 * | `network`          | the underlying error                             |
 * | `timeout`          | the elapsed budget                               |
 * | `http_error`       | the status and the remote `statusText`           |
 * | `unreadable_body`  | the first bytes, length-capped by the caller     |
 * | `schema_mismatch`  | the path and issue code, never the value         |
 * | `too_large`        | the observed size                                |
 * | `redirect_refused` | the target's origin only                         |
 *
 * `schema_mismatch` never logs the value because a response can carry a
 * credential in any field, and the size cap belongs to the caller that read the
 * bytes and knows how many it is willing to keep.
 *
 * The detail is quoted with `JSON.stringify`, which does two jobs at once: the
 * detail's boundaries stay visible even when it is empty, and the line stays one
 * line. Measured: a detail of `"boom\n[ERROR] forged…\r[31mtail"` yields a
 * single physical line carrying no raw `\n`, `\r` or `ESC` — so remote text can
 * neither forge a second log entry nor drive the terminal of whoever reads it.
 * Redaction of credential-shaped substrings happens once more downstream, in
 * `Logger`, on the way to stderr.
 */
export function failureLogDetail(kind: FailureKind, detail: string): string {
  return `http failure kind=${kind} detail=${JSON.stringify(detail)}`;
}
