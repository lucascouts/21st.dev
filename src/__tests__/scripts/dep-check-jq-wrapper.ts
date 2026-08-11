/**
 * A passthrough `jq` that fails ONLY on the summary encode (story 004, R1.1-R1.4).
 *
 * WHY THIS EXISTS, AND WHY IT IS AN EXCEPTION
 *
 * `dep-check-harness.ts:1-23` states the rule this module bends: `bash`, `jq` and
 * `sed` are the harness's OWN dependencies, not the system under test, so they
 * are never shimmed — reimplementing `jq` would be reimplementing `jq`. The only
 * honest `jq` fixture the suite had was its total ABSENCE, which the check
 * short-circuits in `main`'s preflight and which therefore never reaches the
 * summary at all.
 *
 * Defect 1 lives past that short-circuit: `emit_summary_and_exit` records the
 * summary as emitted BEFORE encoding it, so a `jq` that fails at that one call
 * loses the summary entirely and exits with a status the header does not
 * document. Nothing about that is observable without making `jq` fail
 * selectively, and asserting the source's statement order instead would measure
 * the artifact rather than the behaviour — which this project rejects.
 *
 * **The bend is authorised and bounded** (design.md, Implementation Gotchas):
 *
 *  - it resolves the REAL `jq` with `Bun.which` at fixture-build time and hands
 *    every other call straight to it, reimplementing nothing;
 *  - it reaches no network and touches nothing outside its own shim directory;
 *  - it is opt-in per scenario: a run only gets it if the scenario installs it.
 *
 * DISCRIMINATE ON ARGV, NEVER ON A COUNTER. The `bun` fixture calls `jq` itself
 * (`dep-check-harness.ts:307`) under the same PATH, so "fail the Nth call" is
 * order-dependent and would break the moment a scenario changes how many
 * packages `bun info` is asked about. The summary encode is the only call that
 * carries an `exit_code` argument or a `event: "summary"` program, so that is
 * what the wrapper matches.
 *
 * NO HARNESS EDIT IS NEEDED. `runCheck` hands the script
 * `PATH=<shimDir>:<harness bin dir>`, shim dir first, so a `jq` written into the
 * shim directory `makeShimDir` returns shadows the harness's own symlink to the
 * real binary. The scenario builds the shim dir, installs this wrapper into it,
 * and runs — `dep-check-harness.ts` is not touched.
 */

import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the wrapper writes to stdout before failing: a truncated summary object,
 * exactly what a `jq` that died mid-write would leave behind.
 *
 * This is not decoration — it is the discriminator for the wrong fix. Design.md
 * warns that a bare `jq` followed by the flag assignment leaves `set -e`
 * aborting at the `jq`, so `on_exit` emits the incomplete summary and the fix
 * LOOKS correct while being inert. That variant lets this fragment reach stdout
 * and breaks the one-JSON-object-per-line contract; the capture-then-print shape
 * the design asks for swallows it into a variable that is never printed. Without
 * a fragment, the two are indistinguishable from the outside.
 */
export const PARTIAL_SUMMARY_FRAGMENT = '{"event":"summary","exit_code":0,"vulnerabilities":';

/**
 * The status the wrapper exits with. 5 is what the live reproduction on
 * 2026-08-11 observed the whole script exiting with — an undocumented status,
 * which is the second half of the defect.
 */
export const FAILING_JQ_EXIT = 5;

export interface FailingSummaryJqOptions {
  /**
   * Fragment written to stdout before failing. Pass `""` for a `jq` that fails
   * having written nothing.
   */
  partialStdout?: string;
  /** Exit status of the refused call. Defaults to {@link FAILING_JQ_EXIT}. */
  exitStatus?: number;
}

/** One recorded call of the wrapper. */
export interface JqCall {
  /** `true` when the wrapper refused the call instead of delegating it. */
  refused: boolean;
  /** The call's arguments, space-joined as the shim saw them. */
  argv: string;
}

/**
 * Installs the wrapper into an existing shim directory, shadowing the real `jq`
 * for the run that uses that directory.
 *
 * @returns the absolute path of the real `jq` the wrapper delegates to, so a
 *   scenario can state in its failure message which binary was in play.
 */
export async function installFailingSummaryJq(
  shimDir: string,
  options: FailingSummaryJqOptions = {},
): Promise<string> {
  const realJq = Bun.which("jq");
  if (!realJq) {
    throw new Error(
      "the summary-encode fixture needs the real jq on PATH: it delegates every " +
        "other call to it and reimplements nothing",
    );
  }

  const callLog = join(shimDir, "jq-calls.txt");
  const fragment = options.partialStdout ?? PARTIAL_SUMMARY_FRAGMENT;
  const status = options.exitStatus ?? FAILING_JQ_EXIT;

  const body = [
    "#!/bin/bash",
    "# Fixture passthrough for `jq`: every call reaches the real binary except",
    "# the summary encode, which fails after writing a truncated object. See",
    "# dep-check-jq-wrapper.ts for why this one exception is authorised.",
    "set -u",
    `readonly REAL_JQ=${JSON.stringify(realJq)}`,
    `readonly CALL_LOG=${JSON.stringify(callLog)}`,
    `readonly FRAGMENT=${JSON.stringify(fragment)}`,
    "",
    "# Argv, never a counter: the `bun` fixture calls jq too, under this same",
    "# PATH, so any count is order-dependent. `--argjson exit_code` and the",
    "# `event: \"summary\"` program are unique to the summary encode.",
    'for arg in "$@"; do',
    '    case "$arg" in',
    "        exit_code|*'event: \"summary\"'*)",
    '            printf \'refused\\t%s\\n\' "$*" >> "$CALL_LOG"',
    '            [ -n "$FRAGMENT" ] && printf \'%s\' "$FRAGMENT"',
    "            printf 'fixture jq: refusing to encode the summary event\\n' >&2",
    `            exit ${status}`,
    "            ;;",
    "    esac",
    "done",
    "",
    'printf \'passed\\t%s\\n\' "$*" >> "$CALL_LOG"',
    'exec "$REAL_JQ" "$@"',
    "",
  ].join("\n");

  const path = join(shimDir, "jq");
  await writeFile(path, body);
  await chmod(path, 0o755);
  return realJq;
}

/**
 * Every `jq` call the wrapper saw, in order. Empty when the wrapper was never
 * invoked — which, for a scenario that installed it, means the run died before
 * it encoded anything and the scenario is not testing what it thinks.
 */
export async function readJqCalls(shimDir: string): Promise<JqCall[]> {
  const file = Bun.file(join(shimDir, "jq-calls.txt"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [verdict = "", ...rest] = line.split("\t");
      return { refused: verdict === "refused", argv: rest.join("\t") };
    });
}
