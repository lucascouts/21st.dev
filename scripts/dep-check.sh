#!/usr/bin/env bash
#
# dep-check.sh — answer one question about the resolved dependency tree:
#   "is it both current and clean?"  ...and write nothing while answering it.
#
# The check is entirely local: no credentials, no remote write access, no hosted
# service (002 R1.7). The only network traffic is what `bun`, `osv-scanner` and
# `trivy` do on their own to reach the npm registry and their vulnerability
# databases, which is inherent to those tools.
#
# Requirement IDs name their story, because both number their clauses R1.x:
# `002` is supply-chain-durability, `003` is transitive-freshness-coverage.
# Comments below the header cite 003.
#
# WHAT IT DOES
#   1. Freshness (003 R1.1) — an isolated re-resolution, then a lockfile diff.
#      `package.json` is copied into a `mktemp -d` directory OUTSIDE the working
#      tree, with any `bunfig.toml` alongside it so the repository's own
#      release-age cooldown still withholds anything too young to trust
#      (003 R1.3). `bun install --lockfile-only` resolves there, and the lockfile
#      that copy produces is diffed against this repository's. Every package
#      `bun.lock` records is compared — about a hundred — not only the five
#      `package.json` declares.
#
#      That diff IS the semver computation. Bun honours every range, every peer
#      constraint and the cooldown, so each reported update is one a real
#      `bun install` would take today; reimplementing resolution in bash would
#      be subtly wrong in a way nothing here would catch.
#
#      THE REPOSITORY LOCKFILE IS NEVER WRITTEN. Only the copy is resolved into,
#      and the copy is deleted on exit: `bun.lock`, `package.json`,
#      `node_modules/` and gitignored paths such as `dist/` are never touched,
#      and the working tree is left byte-identical (003 R1.2).
#   2. Vulnerabilities (002 R1.2) — the resolved tree is scanned twice, by
#      `osv-scanner` and by `trivy`. Two scanners disagree often enough that
#      running only one is a coverage gap; each count is reported separately.
#
# WHY TWO CHANNELS
#   stdout carries ONLY the machine-readable report — one JSON object per line,
#   no prose — so a caller can pipe it straight into `jq`. Every human-facing
#   diagnostic, including the scanners' own chatter, goes to stderr.
#
# OUTPUT CONTRACT (stdout, one JSON object per line, summary always last)
#   {"event":"scanner","scanner":"osv-scanner","status":"ok","vulnerabilities":0}
#   {"event":"scanner","scanner":"trivy","status":"ok","vulnerabilities":0}
#   {"event":"freshness","status":"ok","examined_count":100,"outdated_count":1,
#    "outdated":[{"name":"jose","key":"jose","scope":"transitive",
#                 "current":"6.2.7","update":"6.2.8"}],
#    "not_taken":[{"name":"typescript","scope":"direct",
#                  "current":"6.0.3","latest":"7.0.2"}]}
#   {"event":"summary","exit_code":1,"vulnerabilities":0,"outdated_count":1,
#    "scanners_errored":0,"freshness_status":"ok"}
#
#   The last two are wrapped above for reading; on the wire, one line each.
#
#   FRESHNESS FIELDS
#     examined_count  how many packages the freshness half actually looked at —
#                     every row of `bun.lock`. Its absence is what let the
#                     original defect ship: without it a reader cannot tell
#                     0-of-5 from 0-of-100, so a query that saw five packages
#                     looked exactly like a tree that was current.
#     outdated        what the re-resolution would move. `key` is the LOCKFILE
#                     KEY, not always the name: a nested resolution carries a
#                     path (`body-parser/content-type`), which is how one name
#                     legitimately appears at two versions. `scope` is "direct"
#                     when this repository owns the semver range and
#                     "transitive" when a parent package does — that is what
#                     says whether the update is yours to make.
#     outdated_count  the length of `outdated`, derived from it so the two can
#                     never disagree. Non-zero is what makes an otherwise
#                     complete run exit 1.
#     not_taken       releases the registry publishes for a DECLARED dependency
#                     that the re-resolution did not take (003 R1.6). Reported
#                     but NOT counted as outdated, because outdated means "what
#                     a re-resolution would produce". The field does not say WHY
#                     a release was not taken, deliberately: the declared range
#                     may forbid it, or the range may allow it while the
#                     release-age cooldown still withholds it, and the two are
#                     indistinguishable from here. Listing them keeps the check
#                     from silently hiding a stale major.
#
#   A `scanner` or `freshness` event with status "errored" carries no count; it
#   carries a "reason" instead. An absent count must never be read as a zero
#   count — that conflation is the failure mode this script exists to prevent.
#
#   `summary.vulnerabilities` is the SUM of the per-scanner counts. The two
#   scanners overlap, so it is a findings signal, not a deduplicated inventory;
#   the per-scanner events carry the precise numbers. Summing never under-reports.
#
# FAILURE REASONS ("reason" on an errored event)
#   A caller that branches on `reason` needs the whole set written down. It is
#   larger than the original design spelled out, deliberately: every failure that
#   can be told apart gets its own reason, because "it failed" sends a reader
#   nowhere. `<N>` is the failing command's own exit status.
#
#   freshness  not_found_on_path · tmpdir_create_failed · manifest_copy_failed ·
#              manifest_read_failed · bunfig_copy_failed · exit_status_<N> ·
#              resolved_lockfile_missing · lockfile_read_failed ·
#              unrecognised_lockfile_format · resolved_lockfile_read_failed ·
#              unrecognised_resolved_lockfile_format ·
#              latest_version_query_failed · unrecognised_latest_version_format ·
#              report_encoding_failed · jq_not_found_on_path
#   scanner    not_found_on_path · exit_status_<N> · unparseable_json ·
#              unreadable_count · jq_not_found_on_path
#
# EXIT CODES — precedence: 2 beats 1 beats 0
#   0  clean and current: no vulnerabilities, no updates, both scanners ran and
#      the freshness half completed (002 R1.4)
#   1  at least one vulnerability or at least one available update (002 R1.3)
#   2  incomplete: a scanner errored, or the freshness half errored, or the run
#      ended before it could report — coverage was partial, so the tree is NOT
#      certified clean (002 R1.5, 003 R1.8)
#
#   The precedence is strict and one-directional — incomplete beats findings
#   beats clean. A missing scanner alongside real findings exits 2, and an
#   errored freshness half exits 2 even when both scanners came back clean. An
#   incomplete check reported as a passing one is the one failure this script
#   exists to prevent.
#
# OFFLINE — a run without network can never report clean
#   Both the re-resolution and the registry lookups need the npm registry, so an
#   offline run reports freshness as errored and exits 2 (003 R1.8): an
#   air-gapped caller will never see exit 0 from this script. That is the honest
#   posture — unknown is not clean — and it is a documented limit, not a defect.
#   The scanners are no exception: whatever one does without its vulnerability
#   database is its own business, but any abnormal exit is reported errored, so
#   it too degrades towards 2 and never towards 0.
#
# PORTABILITY
#   One GNU dependency, and only one: the lockfile-row `sed` expression puts
#   `\t` in its REPLACEMENT. GNU sed turns that into a tab; BSD sed leaves it as
#   a literal "t". macOS is therefore the one place this breaks, and it breaks
#   loudly rather than quietly — no row parses, so freshness is errored with
#   `unrecognised_lockfile_format` and the check exits 2. Putting a GNU sed
#   ahead of `/usr/bin` on PATH is the fix.
#
# USAGE
#   bash scripts/dep-check.sh                       # human run
#   bash scripts/dep-check.sh | jq -c 'select(.event=="summary")'
#
set -euo pipefail

readonly EXIT_CLEAN=0
readonly EXIT_FINDINGS=1
readonly EXIT_INCOMPLETE=2

# Lockfile that pins the resolved tree; both scanners and the freshness diff read it.
readonly LOCKFILE="bun.lock"
# Manifest the re-resolution starts from, and the install policy it must honour.
readonly MANIFEST="package.json"
readonly BUNFIG="bunfig.toml"

# Which exit statuses mean "the tool ran to completion", per tool. Established
# empirically against osv-scanner 2.5.0 and trivy 0.73.0 (see the notes below);
# every other status is treated as a failure, so an unrecognised code degrades
# towards "errored" rather than towards "clean".
#
#   osv-scanner: 0 = scanned/no findings, 1 = scanned/findings found,
#                127 = general error, 128 = no packages found.
#                Finding vulnerabilities is a SUCCESSFUL scan, not an error.
#   trivy:       0 = scanned (findings do not change the status without
#                `--exit-code`), non-zero = fatal error.
readonly OSV_RAN_STATUSES='^(0|1)$'
readonly TRIVY_RAN_STATUSES='^0$'

# Counts a finding once per affected package. `?` guards every step: a clean
# report omits the keys entirely rather than emitting empty arrays.
readonly OSV_COUNT_FILTER='[.results[]?.packages[]?.vulnerabilities[]?] | length'
readonly TRIVY_COUNT_FILTER='[.Results[]?.Vulnerabilities[]?] | length'

# Pulls every package row out of a `bun.lock`, as `key<TAB>name@version`.
#
# `jq` CANNOT read this file: `bun.lock` is JSONC, and its trailing commas make
# `jq -e 'type' bun.lock` die with "Expected another key-value pair at line 10".
# Stripping commas line by line does not help either — the comma and the brace
# that closes its object sit on different lines. So the rows are matched
# textually, which is also what the test harness does:
#
#     "jose": ["jose@6.2.7", "", { ... }, "sha512-..."],
#     "body-parser/content-type": ["content-type@2.0.0", "", {}, "sha512-..."],
#
# The key is NOT always the package name. A nested resolution carries a path,
# which is how one name legitimately appears at two versions.
readonly LOCK_ROW_SED='s/^[[:space:]]*"([^"]+)": \["([^"]+)".*/\1\t\2/p'

# Running totals for the summary.
vulnerability_total=0
outdated_total=0
scanners_errored=0
freshness_status="errored"
summary_emitted=0

# Isolated directory the re-resolution runs in, empty until `check_freshness`
# creates it. Declared HERE, not there, for two reasons: `on_exit` reads it and
# the trap can fire before `check_freshness` has run at all (`set -u` would then
# abort the cleanup), and an empty value must never reach `rm -rf`.
tmpdir=""

# Human-facing diagnostics only. Never prints the environment or any variable
# that could carry a credential.
log() {
    printf 'dep-check: %s\n' "$*" >&2
}

emit_scanner_ok() {
    local scanner="$1" count="$2"
    jq -nc --arg scanner "$scanner" --argjson vulnerabilities "$count" \
        '{event: "scanner", scanner: $scanner, status: "ok", vulnerabilities: $vulnerabilities}'
}

emit_scanner_errored() {
    local scanner="$1" reason="$2"
    jq -nc --arg scanner "$scanner" --arg reason "$reason" \
        '{event: "scanner", scanner: $scanner, status: "errored", reason: $reason}'
}

# Reports the freshness half as errored, on both channels (R1.8).
#
# EVERY failure inside `check_freshness` routes through here and then returns.
# Letting `set -e` abort instead would land in `on_exit`, which emits a summary
# but no `freshness` event at all — so the one thing R1.8 asks for, a reason,
# would be missing exactly when it matters.
#
# The wording names the half, not the step: the re-resolution is one of two
# things that can fail here — asking the registry what it publishes is the other
# — and a diagnostic that blamed the wrong one would send a reader looking in the
# wrong place.
emit_freshness_errored() {
    local reason="$1"
    log "freshness: the check did not complete (${reason}); currency is unknown"
    jq -nc --arg reason "$reason" \
        '{event: "freshness", status: "errored", reason: $reason}'
}

# Runs one vulnerability scanner and emits its event. Updates
# `vulnerability_total` / `scanners_errored`.
#
#   scan <display-name> <ran-statuses-regex> <count-jq-filter> <command> [args...]
#
# The scanner's own exit status decides success, never the shape of its output:
# a tool that dies without printing anything must be distinguishable from a tool
# that printed an empty (clean) report.
scan() {
    local scanner="$1" ran_statuses="$2" count_filter="$3"
    shift 3
    local -a scanner_argv=("$@")

    local failure=""
    local output="" status=0 count=""

    if ! command -v "${scanner_argv[0]}" >/dev/null 2>&1; then
        failure="not_found_on_path"
    else
        output=$("${scanner_argv[@]}") || status=$?
        if [[ ! "$status" =~ $ran_statuses ]]; then
            failure="exit_status_${status}"
        elif ! count=$(printf '%s' "$output" | jq "$count_filter" 2>/dev/null); then
            failure="unparseable_json"
        elif [[ ! "$count" =~ ^[0-9]+$ ]]; then
            failure="unreadable_count"
        fi
    fi

    if [[ -n "$failure" ]]; then
        log "${scanner}: scan did not complete (${failure}); coverage is partial"
        scanners_errored=$((scanners_errored + 1))
        emit_scanner_errored "$scanner" "$failure"
        return 0
    fi

    vulnerability_total=$((vulnerability_total + count))
    emit_scanner_ok "$scanner" "$count"
}

# Every package a `bun.lock` records, printed as `key<TAB>name<TAB>version`.
# Returns non-zero when the file cannot be read at all: `sed` exits 2 on a
# missing file, and "there is no lockfile" must never look like "the lockfile
# records nothing".
#
# Scoped names carry a LEADING `@` — `@hono/node-server@2.0.12` — so the version
# is whatever follows the LAST one. Splitting on the first would call the package
# "" at version "hono/node-server@2.0.12".
lockfile_rows() {
    local lockfile="$1"
    local raw="" key="" entry=""

    raw=$(sed -nE "$LOCK_ROW_SED" "$lockfile") || return 1

    while IFS=$'\t' read -r key entry; do
        [[ -n "$key" && "$entry" == *@* ]] || continue
        # Split on the LAST `@`: a scoped package carries a leading one, so
        # `@hono/node-server@2.0.12` must yield the name, not an empty string.
        # Limit worth naming: an alias or URL specifier (`pkg@npm:other@1.0.0`,
        # `pkg@https://…/x.tgz`) would misparse here. None exists in this
        # lockfile — checked, not assumed — so this is a boundary to revisit if
        # one is ever introduced, not a live defect.
        printf '%s\t%s\t%s\n' "$key" "${entry%@*}" "${entry##*@}"
    done <<<"$raw"
    return 0
}

# Reports which packages a re-resolution would move (R1.1, R1.4, R1.5).
#
# The tree is re-resolved in a `mktemp -d` copy OUTSIDE the working tree and the
# two lockfiles are diffed. Asking Bun what it would actually do beats
# reimplementing resolution here: Bun already honours every semver range, every
# peer constraint and the release-age quarantine, and it answers for all ~100
# recorded packages rather than only the 5 the manifest declares.
#
# The copy is what keeps the repository byte-identical (R1.2), gitignored paths
# included.
#
# WHY THE LIFECYCLE HOOK IS GUARDED THREE TIMES. `package.json` declares
# "prepare": "bun run build", and the hazard is not hypothetical. The obvious
# way to ask this question, `bun update --dry-run`, executed that hook and
# rewrote the gitignored `dist/index.js` — 1.11 MB of it. A dry run performed a
# write and arbitrary code execution inside a security check, and `git status`
# said nothing, because the file is ignored. Hence three guards, deliberately
# redundant:
#
#   1. the manifest is copied through `jq 'del(.scripts)'`, which removes the
#      hazard at its source — there is no hook left to run;
#   2. `--ignore-scripts` is passed anyway, belt-and-braces, so a lifecycle
#      script arriving some other way (a dependency's own install script) is
#      still not executed;
#   3. the copy carries no `src/`, so a hook that somehow ran would find nothing
#      to build.
#
# `bunfig.toml` travels into the copy too, so the re-resolution applies this
# repository's own `install.minimumReleaseAge`, making every reported update one
# a real `bun install` would take today (R1.3).
#
# On top of that diff it reports `not_taken` (R1.6): a release the registry
# publishes for a DECLARED dependency that the re-resolution did not take. That
# is a different question from "what moved", so it is a different field and it is
# not counted — see the loop below for why it stays scoped to the 5 declared
# packages and why it never claims to know the reason.
#
# The re-resolution needs the registry, so an offline run reports errored and the
# check exits incomplete. Unknown is not clean.
check_freshness() {
    local install_status=0 resolved_lockfile=""
    local recorded="" resolved="" declared="" event=""
    local declared_name="" info_answer="" latest="" published=""

    if ! command -v bun >/dev/null 2>&1; then
        emit_freshness_errored "not_found_on_path"
        return 0
    fi

    # Outside the working tree, so nothing the re-resolution writes can land in
    # the repository. On failure the check stops here: continuing with an empty
    # `tmpdir` would point the cleanup at the wrong path entirely.
    if ! tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/dep-check-resolve.XXXXXXXX"); then
        tmpdir=""
        emit_freshness_errored "tmpdir_create_failed"
        return 0
    fi
    resolved_lockfile="$tmpdir/$LOCKFILE"

    # `jq 'del(.scripts)'`, not `cp`: the manifest declares
    # "prepare": "bun run build". Removing the hook at the source is a stronger
    # guarantee than trusting a flag to suppress it.
    if ! jq 'del(.scripts)' "$MANIFEST" >"$tmpdir/$MANIFEST"; then
        emit_freshness_errored "manifest_copy_failed"
        return 0
    fi

    # Which packages this repository owns the semver range of. Read here, before
    # the network step, so a manifest problem fails in milliseconds instead of
    # after a full re-resolution. A transitive package's range belongs to its
    # parent, so this is what tells a reader whether an update is theirs to make.
    if ! declared=$(jq -r '((.dependencies // {}) + (.devDependencies // {})) | keys[]' \
        "$MANIFEST"); then
        emit_freshness_errored "manifest_read_failed"
        return 0
    fi

    # Verbatim, so the cooldown policy applies exactly as it does here (R1.3).
    # An absent bunfig is not a failure — a copy that fails is.
    if [[ -f "$BUNFIG" ]] && ! cp -- "$BUNFIG" "$tmpdir/$BUNFIG"; then
        emit_freshness_errored "bunfig_copy_failed"
        return 0
    fi

    # A subshell, so a failed `cd` cannot leave the rest of the check running
    # outside the repository root. `bun install` prints its banner and its
    # "Saved bun.lock" line on STDOUT; letting that inherit would put prose on
    # the one-JSON-object-per-line channel, so it is moved to the journal —
    # redirected rather than discarded, because it is the diagnostic that
    # explains a failed re-resolution.
    ( cd -- "$tmpdir" && bun install --lockfile-only --ignore-scripts ) >&2 || install_status=$?
    if [[ "$install_status" -ne 0 ]]; then
        emit_freshness_errored "exit_status_${install_status}"
        return 0
    fi
    # "Exited 0 but wrote no lockfile" is a different failure from "wrote a
    # lockfile nothing could be read out of"; conflating them hides which one.
    if [[ ! -f "$resolved_lockfile" ]]; then
        emit_freshness_errored "resolved_lockfile_missing"
        return 0
    fi

    if ! recorded=$(lockfile_rows "$LOCKFILE"); then
        emit_freshness_errored "lockfile_read_failed"
        return 0
    fi
    # An extraction that silently yields nothing must never read as a current
    # tree. That unearned zero is the failure mode this whole check exists to
    # prevent, so a lockfile the row matcher cannot see into is errored instead.
    if [[ -z "$recorded" ]]; then
        emit_freshness_errored "unrecognised_lockfile_format"
        return 0
    fi

    if ! resolved=$(lockfile_rows "$resolved_lockfile"); then
        emit_freshness_errored "resolved_lockfile_read_failed"
        return 0
    fi
    if [[ -z "$resolved" ]]; then
        emit_freshness_errored "unrecognised_resolved_lockfile_format"
        return 0
    fi

    # What the registry publishes, asked ONLY about the packages this repository
    # declares (R1.6). A release a re-resolution will not take is actionable
    # exactly where the constraint is owned here; for a transitive package the
    # range belongs to its parent, so the ~100 lookups that would surface it buy
    # an answer nobody reading this can act on — about twenty times the network
    # traffic of these five.
    #
    # Machine-readable by construction (R1.7). `bun info <pkg> version --json`
    # answers with a bare JSON string — `"7.0.2"`, NOT `{"version":"7.0.2"}`, so
    # `jq -r '.version'` on it dies with "Cannot index string with string". The
    # shape is therefore checked rather than assumed: a non-zero exit (a 404 on an
    # unknown package, an unreachable registry) or any other shape is errored, and
    # never an empty `not_taken` — that would silently claim every published
    # release had been taken.
    #
    # Runs from the repository root, never from `$tmpdir`: `bun info` refuses to
    # answer without a `package.json` in the working directory ("Bun could not
    # find a package.json file to install from", exit 1) whatever package is
    # asked about. Its stderr is left to reach the journal, because the 404 line
    # is the diagnostic that explains the failure. `</dev/null` so a query can
    # never consume the loop's own input.
    while IFS= read -r declared_name; do
        [[ -n "$declared_name" ]] || continue
        if ! info_answer=$(bun info "$declared_name" version --json </dev/null); then
            emit_freshness_errored "latest_version_query_failed"
            return 0
        fi
        if ! latest=$(printf '%s' "$info_answer" \
            | jq -er 'if type == "string" and length > 0 then . else empty end'); then
            emit_freshness_errored "unrecognised_latest_version_format"
            return 0
        fi
        published+="${declared_name}"$'\t'"${latest}"$'\n'
    done <<<"$declared"

    # The diff is keyed on the LOCKFILE KEY, never the bare package name.
    # `bun.lock` legitimately resolves one name at two versions — `content-type`
    # at the root and `body-parser/content-type` beneath it — and diffing by name
    # would report that dual resolution as drift that never happened. `key` is
    # what identifies the resolution; `name` stays the human-facing package.
    #
    # `outdated_count` is derived from the array it describes, so the two can
    # never disagree, and `examined_count` says how many packages were compared:
    # without it, a zero out of 5 is indistinguishable from a zero out of 100 —
    # which is precisely how the manifest-scoped defect shipped unnoticed.
    #
    # `not_taken` compares each published release against the version the
    # RE-RESOLUTION produced, not against the recorded one: a release the tree is
    # about to move to has been taken, and reporting it here as well would
    # contradict `outdated`. That also makes the entry's `current` equal to what
    # `outdated` would call `update`, which is why no `update` field is carried.
    #
    # The comparison is deliberately weaker than "outside the declared range" and
    # says so by its name. With `bunfig.toml` in the copy, a release inside the
    # range but younger than the cooldown is equally not taken, and nothing here
    # can tell the two apart — a range test would report the second as available
    # and be wrong. Reimplementing semver in bash to sharpen this would be subtly
    # wrong in a way nothing would catch, so the field claims only what was
    # observed.
    #
    # Every declared package is looked up by its own name because a declared
    # dependency is a TOP-LEVEL lockfile entry, whose key is exactly that name.
    # A declared name absent from the resolved lockfile has nothing to compare
    # against and is skipped: a boundary worth naming, not a live case — a
    # re-resolution that dropped a declared dependency would be broken in a way
    # `bun install` would have failed on first.
    if ! event=$(printf '%s\n' "$recorded" | jq -Rsc \
        --arg resolved "$resolved" \
        --arg declared "$declared" \
        --arg published "$published" '
        def rows: [ split("\n")[]
                    | select(length > 0)
                    | split("\t")
                    | {key: .[0], name: .[1], version: .[2]} ];

        rows as $recorded
        | ($resolved | rows | map({(.key): .version}) | add // {}) as $now
        | ($declared | split("\n") | map(select(length > 0))) as $direct
        | [ $recorded[]
            | . as $entry
            | $now[$entry.key] as $update
            | select($update != null and $update != $entry.version)
            | { name:    $entry.name,
                key:     $entry.key,
                scope:   (if $direct | index($entry.name) then "direct" else "transitive" end),
                current: $entry.version,
                update:  $update } ] as $outdated
        | [ $published
            | split("\n")[]
            | select(length > 0)
            | split("\t")
            | { name:    .[0],
                scope:   "direct",
                current: $now[.[0]],
                latest:  .[1] }
            | select(.current != null and .current != .latest) ] as $not_taken
        | { event: "freshness",
            status: "ok",
            examined_count: ($recorded | length),
            outdated_count: ($outdated | length),
            outdated: $outdated,
            not_taken: $not_taken }
    '); then
        emit_freshness_errored "report_encoding_failed"
        return 0
    fi

    if ! outdated_total=$(printf '%s' "$event" | jq '.outdated_count'); then
        emit_freshness_errored "report_encoding_failed"
        return 0
    fi

    freshness_status="ok"
    printf '%s\n' "$event"
}

# Last-resort safety net. If the script dies before reporting — a `set -e` abort,
# or any path that reaches `exit` — stdout would otherwise end without a summary
# and the process would exit with an undocumented status, which a caller could
# not distinguish from a clean run. Emit an honest "incomplete" report instead.
# Uses printf with %d on already-validated integers, so it works even if jq is
# what broke.
#
# What this does NOT cover, stated rather than implied: only EXIT is trapped, so
# a signal that terminates the shell under its default disposition — SIGINT from
# a Ctrl-C during the network-bound re-resolution, SIGTERM, SIGKILL — runs none
# of this. No summary is emitted and the isolated copy leaks. The leak is bounded
# to $TMPDIR and can never touch the repository, which is why it is accepted
# rather than fixed here; `trap 'on_exit' EXIT INT TERM` would close the first
# two, at the cost of changing what the script's exit status means on interrupt.
#
# The disable below is a false positive: this function IS invoked, indirectly,
# by the `trap ... EXIT` registered right after it. ShellCheck 0.11 loses that
# link once another function in the file calls `exit` unconditionally.
# shellcheck disable=SC2329
on_exit() {
    # Removing the isolated copy is the FIRST thing this does, deliberately.
    # Bash allows exactly one EXIT trap and this is it — a second `trap ... EXIT`
    # would silently destroy the incomplete-summary net below — so the cleanup
    # has to live here, and it has to run before the early return and before the
    # `exit` at the end, either of which would otherwise skip it. Guarded on a
    # non-empty path so `rm -rf` can never be handed nothing, idempotent so a
    # re-entry is harmless, and `|| true` so `rm` cannot change the status the
    # script exits with.
    if [[ -n "$tmpdir" && -d "$tmpdir" ]]; then
        rm -rf -- "$tmpdir" || true
        tmpdir=""
    fi

    if [[ "$summary_emitted" -eq 1 ]]; then
        return 0
    fi
    log "the check ended before it could report; treating coverage as incomplete"
    printf '{"event":"summary","exit_code":%d,"vulnerabilities":%d,"outdated_count":%d,"scanners_errored":%d,"freshness_status":"errored"}\n' \
        "$EXIT_INCOMPLETE" "$vulnerability_total" "$outdated_total" "$scanners_errored"
    exit "$EXIT_INCOMPLETE"
}
trap 'on_exit' EXIT

emit_summary_and_exit() {
    local exit_code="$1"
    summary_emitted=1
    jq -nc \
        --argjson exit_code "$exit_code" \
        --argjson vulnerabilities "$vulnerability_total" \
        --argjson outdated_count "$outdated_total" \
        --argjson scanners_errored "$scanners_errored" \
        --arg freshness_status "$freshness_status" \
        '{event: "summary",
          exit_code: $exit_code,
          vulnerabilities: $vulnerabilities,
          outdated_count: $outdated_count,
          scanners_errored: $scanners_errored,
          freshness_status: $freshness_status}'
    exit "$exit_code"
}

main() {
    # Without jq the report cannot be encoded safely, so say so in the contract's
    # own vocabulary rather than dying mid-report. Every value here is a literal.
    if ! command -v jq >/dev/null 2>&1; then
        log "jq is required to encode the report but is not on PATH"
        summary_emitted=1
        printf '%s\n' \
            '{"event":"scanner","scanner":"osv-scanner","status":"errored","reason":"jq_not_found_on_path"}' \
            '{"event":"scanner","scanner":"trivy","status":"errored","reason":"jq_not_found_on_path"}' \
            '{"event":"freshness","status":"errored","reason":"jq_not_found_on_path"}' \
            '{"event":"summary","exit_code":2,"vulnerabilities":0,"outdated_count":0,"scanners_errored":2,"freshness_status":"errored"}'
        exit "$EXIT_INCOMPLETE"
    fi

    # Run from the repository root so the relative paths below hold no matter
    # where the caller invoked the script from.
    local script_dir repo_root
    script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
    repo_root=$(dirname -- "$script_dir")
    cd -- "$repo_root"

    scan "osv-scanner" "$OSV_RAN_STATUSES" "$OSV_COUNT_FILTER" \
        osv-scanner scan source "--lockfile=${LOCKFILE}" --format=json
    scan "trivy" "$TRIVY_RAN_STATUSES" "$TRIVY_COUNT_FILTER" \
        trivy fs --scanners vuln --format=json .
    check_freshness

    if [[ "$scanners_errored" -gt 0 || "$freshness_status" != "ok" ]]; then
        log "coverage was partial — the tree is NOT certified clean"
        emit_summary_and_exit "$EXIT_INCOMPLETE"
    fi
    if [[ "$vulnerability_total" -gt 0 || "$outdated_total" -gt 0 ]]; then
        log "found ${vulnerability_total} vulnerability finding(s) and ${outdated_total} available update(s)"
        emit_summary_and_exit "$EXIT_FINDINGS"
    fi
    log "clean and current"
    emit_summary_and_exit "$EXIT_CLEAN"
}

main "$@"
