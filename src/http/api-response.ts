import { z } from "zod";

/**
 * What the Magic API is allowed to hand across the boundary, declared ONCE
 * (story 006, R1.1, R1.3).
 *
 * The consumed surface was measured before it was written down: three tools —
 * `magic_component_inspiration`, `magic_component_builder` and
 * `magic_component_refiner` — read exactly one field, `text`, from two endpoints
 * (`/api/fetch-ui`, `/api/refine-ui`). One shape, so one schema. Three copies of
 * `z.object({ text: z.string() })` would be three places for the shape to drift
 * apart, and a schema that disagrees with its siblings is a validation that only
 * looks like one.
 *
 * It lives beside `client.ts` and `failure.ts` rather than inside a tool for two
 * reasons. It is boundary vocabulary — the statement of what may cross, next to
 * the code that runs it and the code that names what happens when it does not.
 * And putting it in one of the three tools would make the other two import from
 * a sibling tool, coupling them to each other for no reason beyond alphabetical
 * accident.
 *
 * `health-check` is deliberately NOT a consumer of this schema. It reads only
 * `ok` and `status`, so it passes `z.unknown()` — an explicit statement that it
 * consumes no body. Inventing a shape for `/health` that nobody reads would be a
 * fiction with the same form as the `as T` this story removes.
 */

/**
 * The one shape three tools consume: a `text` field carrying the snippet.
 *
 * Two properties of zod's default object behaviour are load-bearing here, and
 * both are wanted:
 *
 * - **Unknown keys are STRIPPED, not refused.** The API may add fields, and a
 *   `.strict()` schema would turn every such addition into an outage. It also
 *   means `data` carries only `text`: a field nobody reads cannot ride onward
 *   into a tool result on the strength of having arrived.
 * - **`text` must be a string, not something string-ish.** Measured 2026-08-12
 *   on the shipped code: `{"text":123}` reached the agent as `"123"` and
 *   `{"text":{"a":1}}` as `"[object Object]"`, both silently. `z.string()` does
 *   not coerce, so those are now a named failure instead of a plausible lie.
 */
export const textResponseSchema = z.object({
  text: z.string(),
});

/** The validated body, for a caller that needs to name the type. */
export type TextResponse = z.infer<typeof textResponseSchema>;
