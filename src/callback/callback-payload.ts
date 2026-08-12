import { z } from "zod";

/**
 * What a loopback callback POST is allowed to become (story 006, R4.3).
 *
 * Before this, `CallbackServer` resolved the waiter with `await req.text()`
 * verbatim — measured 2026-08-12: a plain loopback POST reached the agent
 * byte-identical. Any string was therefore a whole tool output.
 *
 * It lives beside `callback-server.ts` rather than inside it for the reason
 * `src/http/api-response.ts` lives beside `client.ts`: it is boundary
 * vocabulary — the statement of what may cross — and it has more than one
 * consumer. The server parses with it; `create-ui` and `canvas-ui` name the
 * validated type (design.md `## Fix Approach 4`, where `BrowserOutcome`'s
 * `opened` variant carries a `CallbackPayload`). A tool that only needs the
 * type should not have to import the server to get it.
 *
 * WHAT THIS DOES NOT DO. It does not authenticate the callback. A local process
 * that sets `Origin: https://21st.dev` still reaches this schema, and a
 * schema-shaped body from that process is accepted (story.md Assumption 3).
 * What is closed is narrower and real: a body that is not a JSON object, a
 * field of the wrong type, and a field nobody named riding onward.
 */

/**
 * The fields the payload may carry, and the source of each.
 *
 * The upstream project never parsed this body — `git log` shows no `JSON.parse`
 * of a callback response in any version — so the field names come from what
 * this repository states about the body, not from a guess about the remote:
 *
 * - `text` — the snippet a component arrives as. `create-ui` renders the
 *   callback result through the same `formatResponse` it gives
 *   `textResponseSchema`'s `text` on the API path, so this is that value's
 *   counterpart on the browser path.
 * - `code` — the same content under the name the callback may use for it.
 * - `component`, `props` — the pair pinned by the pre-existing transport test
 *   `callback-server.test.ts`, which posts `{ component, props }` and reads
 *   `component` back off the resolved value.
 *
 * Every field is optional because no single body carries all four; the
 * `.refine` below is what stops "all optional" from meaning "anything goes".
 *
 * Two zod behaviours are load-bearing here, both wanted, both matching the
 * precedent in `api-response.ts`:
 *
 * - **Unknown keys are STRIPPED, not refused.** The remote may add fields, and
 *   `.strict()` would turn every such addition into a dead callback. Stripping
 *   also means only named fields ride onward: a key nobody reads cannot reach
 *   the agent on the strength of having arrived.
 * - **No coercion.** `z.string()` refuses `{"text":123}` instead of delivering
 *   `"123"` — the silent conversion measured on the API path in this same
 *   story.
 */
const callbackPayloadObject = z.object({
  text: z.string().optional(),
  code: z.string().optional(),
  component: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The one custom check's message. A constant of ours, never remote text, which
 * is why `describeIssues` may put it in a log line.
 */
const NO_RENDERABLE_FIELD = "carries none of text, code or component";

/**
 * A payload must carry something a consumer can render.
 *
 * Without this, `{}` and `{"anything":1}` both parse to `{}`, and the waiter —
 * which resolves exactly once — would be spent on a payload with nothing in it.
 * Refusing instead keeps the window open, logs why, and lets the caller fall
 * back to the API. `props` alone does not qualify: props with no component to
 * apply them to are not a result.
 */
export const callbackPayloadSchema = callbackPayloadObject.refine(
  (payload) =>
    payload.text !== undefined || payload.code !== undefined || payload.component !== undefined,
  { message: NO_RENDERABLE_FIELD }
);

/** The validated payload, for a consumer that needs to name the type. */
export type CallbackPayload = z.infer<typeof callbackPayloadSchema>;

/**
 * A validated payload, or the reason there is none.
 *
 * A refusal travels as a value rather than a throw so the server can answer it
 * without unwinding through a `catch` that would also have to distinguish it
 * from a genuine fault.
 */
export type CallbackPayloadResult =
  | { readonly ok: true; readonly payload: CallbackPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse a callback body into a payload, or say why it is not one.
 *
 * `reason` is safe to log by construction: it is built from the issue path and
 * code, plus our own constant for the one custom check. The refused body never
 * appears in it — see the `catch` below for the one place that is not obvious.
 */
export function parseCallbackPayload(body: string): CallbackPayloadResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // The engine's own parse message quotes the offending bytes
    // (`JSON Parse error: Unexpected identifier "…"`), so it is deliberately
    // discarded: logging it would put the refused body into the very log line
    // this refusal exists to keep readable.
    return { ok: false, reason: "body is not valid JSON" };
  }

  const result = callbackPayloadSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, reason: describeIssues(result.error.issues) };
  }

  return { ok: true, payload: result.data };
}

/**
 * Issues as a log line: where, and what kind — never the value that failed
 * (design.md `## Error Handling`).
 *
 * `custom` is the one code reported by name instead. The schema has exactly one
 * custom check, so substituting its constant is exact, and the constant is ours
 * — naming the broken rule echoes nothing remote. `issue.message` is not read
 * at all, so no zod-generated string can reach a log through here.
 */
function describeIssues(
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly code: string }>
): string {
  return issues
    .map((issue) => {
      // `map(String)` rather than a bare `join`: joining an array holding a
      // symbol throws, and a log line must not be able to raise.
      const where = issue.path.map(String).join(".") || "<payload>";
      const what = issue.code === "custom" ? NO_RENDERABLE_FIELD : issue.code;
      return `${where}: ${what}`;
    })
    .join("; ");
}
