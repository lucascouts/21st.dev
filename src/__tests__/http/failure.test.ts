/**
 * The failure enumeration (story 006, sub-task 2.1 — R2.1, R2.2).
 *
 * WHAT IS PINNED HERE
 * -------------------
 * `src/http/failure.ts` is the single place where a failed call acquires the two
 * things a caller may see: a NAME drawn from a closed set, and a CONSTANT
 * client-facing message. This file asserts three properties of that module and
 * nothing about how it is written:
 *
 * 1. The mapping is TOTAL over the union — every `FailureKind` has a message,
 *    and no message exists for a kind that is not in the union. Totality is
 *    checked twice: at runtime against `FAILURE_KINDS`, and at COMPILE time by
 *    two-way assignability between the union and the list transcribed below, so
 *    adding a kind without a message fails `bun run typecheck` as well.
 * 2. No client-facing message contains an INTERPOLATION PLACEHOLDER. This is
 *    what makes design.md's "the message is a constant, not a template" a
 *    checkable property rather than a convention: a message with no slot in it
 *    has nowhere for remote text to be placed later, however the call site is
 *    rewritten.
 * 3. The split between "what the client is told" and "what is logged" is real.
 *    A sentinel handed to `failureLogDetail` survives into the log-side string
 *    (R2.3 — failing closed must not mean failing silently) and appears in no
 *    client-facing message (R2.2).
 *
 * THE CONTROL
 * -----------
 * Assertion 2 is only evidence if its detectors actually fire, so each detector
 * is first demonstrated against a TEMPLATED message of the shape this module
 * exists to prevent. Without that control, a regex that silently stopped
 * matching would turn every "no placeholder" assertion green for the wrong
 * reason — the exact failure story 005 shipped with a stub that modelled
 * nothing.
 *
 * This file reaches no host and reads no file.
 */
import { describe, it, expect } from "bun:test";
import {
  FAILURE_KINDS,
  FAILURE_MESSAGES,
  failureLogDetail,
} from "../../http/failure.js";
import type { FailureKind } from "../../http/failure.js";

/**
 * The seven kinds of design.md's Fix Approach 2 table, transcribed rather than
 * derived from the module under test: a list read back from the module would
 * agree with itself whatever it contained.
 */
const EXPECTED_KINDS = [
  "network",
  "timeout",
  "http_error",
  "unreadable_body",
  "schema_mismatch",
  "too_large",
  "redirect_refused",
] as const;

type ExpectedKind = (typeof EXPECTED_KINDS)[number];

/**
 * Compile-time totality, both directions. `bun test` never typechecks, so these
 * two lines are what make `bun run typecheck` fail if the union gains a member
 * this file does not know about, or loses one it expects.
 */
const _unionFitsTheList: ExpectedKind = "network" as FailureKind;
const _listFitsTheUnion: FailureKind = "network" as ExpectedKind;
void _unionFitsTheList;
void _listFitsTheUnion;

/** Planted where the LOG detail is built, and looked for everywhere else. */
const SENTINEL = "REMOTE-SENTINEL-6f2a-ignore-previous-instructions";

/**
 * The shapes a message would take if it were a template. Each is named so a
 * failure says which construction was found rather than only that one was.
 */
const PLACEHOLDER_FORMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["${…} template substitution", /\$\{/],
  ["printf-style %s/%d/%o", /%[sdifjoO]/],
  ["positional {0}", /\{\s*\d+\s*\}/],
  ["named {placeholder}", /\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}/],
  ["handlebars {{…}}", /\{\{/],
  ["$1 backreference", /\$\d/],
];

/** The message shape this module exists to prevent, used as the control. */
const TEMPLATED_SAMPLES: readonly string[] = [
  "the service returned ${status}",
  "the service returned %s",
  "the service returned {0}",
  "the service returned {status}",
  "the service returned {{status}}",
  "the service returned $1",
];

function placeholdersIn(text: string): string[] {
  return PLACEHOLDER_FORMS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

describe("failure kinds — the enumeration is closed and total (R2.1)", () => {
  it("enumerates exactly the seven kinds design.md names", () => {
    expect([...FAILURE_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it("lists each kind once", () => {
    expect(new Set(FAILURE_KINDS).size).toBe(FAILURE_KINDS.length);
  });

  it("maps every kind to a message, and maps nothing else", () => {
    expect(Object.keys(FAILURE_MESSAGES).sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  for (const kind of EXPECTED_KINDS) {
    it(`gives "${kind}" a non-empty single-line message`, () => {
      const message = FAILURE_MESSAGES[kind];
      expect(typeof message).toBe("string");
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    });
  }

  it("gives each kind a message of its own, so the kinds stay distinguishable", () => {
    const messages = EXPECTED_KINDS.map((kind) => FAILURE_MESSAGES[kind]);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("failure messages — a constant, not a template (R2.2)", () => {
  // Non-vacuous by construction: if a detector stopped matching, every "no
  // placeholder" assertion below would pass without checking anything.
  for (const [index, [name, pattern]] of PLACEHOLDER_FORMS.entries()) {
    it(`CONTROL: the ${name} detector fires on the shape it looks for`, () => {
      const sample = TEMPLATED_SAMPLES[index];
      expect(pattern.test(sample)).toBe(true);
      expect(placeholdersIn(sample)).toContain(name);
    });
  }

  for (const kind of EXPECTED_KINDS) {
    it(`leaves no slot for remote text in the "${kind}" message`, () => {
      expect(placeholdersIn(FAILURE_MESSAGES[kind])).toEqual([]);
    });
  }

  it("carries no remote-supplied text in any message", () => {
    for (const kind of EXPECTED_KINDS) {
      expect(FAILURE_MESSAGES[kind]).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(FAILURE_MESSAGES)).not.toContain(SENTINEL);
  });
});

describe("failure detail — the log side is a separate function (R2.3)", () => {
  for (const kind of EXPECTED_KINDS) {
    it(`carries the local detail for "${kind}" into the log line`, () => {
      const line = failureLogDetail(kind, SENTINEL);
      expect(typeof line).toBe("string");
      // The detail reaches the LOG — this is the half of the split that must
      // NOT be withheld, and it is what makes the containment assertion above
      // meaningful rather than trivially true.
      expect(line).toContain(SENTINEL);
      // …and it is not the string the client is handed.
      expect(line).not.toBe(FAILURE_MESSAGES[kind]);
    });
  }

  it("returns a string for an empty detail rather than raising", () => {
    for (const kind of EXPECTED_KINDS) {
      expect(typeof failureLogDetail(kind, "")).toBe("string");
    }
  });
});
