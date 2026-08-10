#!/usr/bin/env bash
#
# dep-check.sh — answer one question about the resolved dependency tree:
#   "is it both current and clean?"  ...and write nothing while answering it.
#
# The check is entirely local: no credentials, no remote write access, no hosted
# service (R1.7). The only network traffic is what `bun`, `osv-scanner` and
# `trivy` do on their own to reach the npm registry and their vulnerability
# databases, which is inherent to those tools.
#
# WHAT IT DOES
#   1. Freshness (R1.1) — `bun outdated`, a read-only query, reports what a
#      re-resolution would produce. `bun.lock`, `package.json` and
#      `node_modules/` are never touched.
#   2. Vulnerabilities (R1.2) — the resolved tree is scanned twice, by
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
#   {"event":"freshness","status":"ok","outdated_count":0,"outdated":[]}
#   {"event":"summary","exit_code":0,"vulnerabilities":0,"outdated_count":0,"scanners_errored":0}
#
#   A `scanner` or `freshness` event with status "errored" carries no count; it
#   carries a "reason" instead. An absent count must never be read as a zero
#   count — that conflation is the failure mode this script exists to prevent.
#
#   `summary.vulnerabilities` is the SUM of the per-scanner counts. The two
#   scanners overlap, so it is a findings signal, not a deduplicated inventory;
#   the per-scanner events carry the precise numbers. Summing never under-reports.
#
#   The freshness event also carries "out_of_range": releases newer than what is
#   installed that the current `package.json` ranges cannot reach (e.g. a major
#   bump). They are reported but NOT counted as outdated, because R1.1 defines
#   outdated as "what a re-resolution would produce", and a re-resolution cannot
#   cross a semver range. Listing them keeps the script from silently hiding a
#   stale major.
#
# EXIT CODES
#   0  clean and current: no vulnerabilities, no updates, both scanners ran (R1.4)
#   1  at least one vulnerability or at least one available update (R1.3)
#   2  a scanner (or the freshness query) errored — coverage was partial, so the
#      tree is NOT certified clean (R1.5). This takes precedence over 1: an
#      incomplete check must never be reported as a passing one.
#
# USAGE
#   bash scripts/dep-check.sh                       # human run
#   bash scripts/dep-check.sh | jq -c 'select(.event=="summary")'
#
set -euo pipefail

readonly EXIT_CLEAN=0
readonly EXIT_FINDINGS=1
readonly EXIT_INCOMPLETE=2

# Lockfile that pins the resolved tree; both scanners and `bun outdated` read it.
readonly LOCKFILE="bun.lock"

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

# `bun outdated` has no JSON mode in Bun 1.3.x, so its ASCII table is parsed.
# The parse is strict on purpose: anything that does not look like the expected
# table is reported as errored rather than quietly counted as zero.
#
#   |----------------------------------------------|
#   | Package          | Current | Update | Latest |
#   |------------------|---------|--------|--------|
#   | typescript (dev) | 6.0.3   | 6.0.3  | 7.0.2  |
#   |----------------------------------------------|
#
# shellcheck disable=SC2016  # awk field refs ($0, $2, ...) must reach awk unexpanded
readonly OUTDATED_TABLE_AWK='
BEGIN { FS = "|"; OFS = "\t" }
function trim(value) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", value); return value }
/^\|/ {
    if ($0 ~ /^\|[-|]+\|$/) next          # rule between rows
    if (NF != 6) next                     # not a four-column data row
    name = trim($2)
    if (name == "Package") next           # column headings
    current = trim($3); update = trim($4); latest = trim($5)
    scope = "prod"
    if (match(name, /\([a-z]+\)$/)) {     # trailing "(dev)", "(peer)", ...
        scope = substr(name, RSTART + 1, RLENGTH - 2)
        name = trim(substr(name, 1, RSTART - 1))
    }
    if (name == "" || current == "" || update == "" || latest == "") next
    print name, scope, current, update, latest
}
'

# Running totals for the summary.
vulnerability_total=0
outdated_total=0
scanners_errored=0
freshness_status="errored"
summary_emitted=0

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

emit_freshness_errored() {
    local reason="$1"
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

# Reports what a re-resolution would change, without performing one (R1.1).
#
# `--ignore-scripts` is defensive: `bun update --dry-run` runs the `prepare`
# lifecycle script, which rebuilds `dist/` — a write, and arbitrary code
# execution inside a security check. `bun outdated` does not run scripts, and
# the flag keeps it that way.
check_freshness() {
    local failure=""
    local output="" status=0 rows="" event=""
    local -a row_lines=()

    if ! command -v bun >/dev/null 2>&1; then
        failure="not_found_on_path"
    else
        output=$(bun outdated --ignore-scripts) || status=$?
        if [[ "$status" -ne 0 ]]; then
            failure="exit_status_${status}"
        elif ! rows=$(printf '%s\n' "$output" | awk "$OUTDATED_TABLE_AWK"); then
            failure="table_parse_failed"
        else
            if [[ -n "$rows" ]]; then
                mapfile -t row_lines <<<"$rows"
            fi
            # A printed table with nothing parseable in it means the output
            # format moved; report that instead of an unearned zero.
            if [[ ${#row_lines[@]} -eq 0 ]] && printf '%s\n' "$output" | grep -qE '^\| *Package *\|'; then
                failure="unrecognised_table_format"
            fi
        fi
    fi

    if [[ -n "$failure" ]]; then
        log "freshness: bun outdated did not complete (${failure})"
        emit_freshness_errored "$failure"
        return 0
    fi

    # `outdated_count` is derived from the array it describes, so the two can
    # never disagree.
    if ! event=$(printf '%s' "$rows" | jq -Rsc '
        [ split("\n")[]
          | select(length > 0)
          | split("\t")
          | {name: .[0], scope: .[1], current: .[2], update: .[3], latest: .[4]}
        ]
        | { outdated:     [ .[] | select(.update != .current) ],
            out_of_range: [ .[] | select(.update == .current and .latest != .current) ] }
        | { event: "freshness",
            status: "ok",
            outdated_count: (.outdated | length),
            outdated: .outdated,
            out_of_range: .out_of_range }
    '); then
        log "freshness: could not encode the outdated list"
        emit_freshness_errored "report_encoding_failed"
        return 0
    fi

    if ! outdated_total=$(printf '%s' "$event" | jq '.outdated_count'); then
        log "freshness: could not read back the outdated count"
        emit_freshness_errored "report_encoding_failed"
        return 0
    fi

    freshness_status="ok"
    printf '%s\n' "$event"
}

# Last-resort safety net. If the script dies before reporting — a `set -e` abort,
# a signal — stdout would otherwise end without a summary and the process would
# exit with an undocumented status, which a caller could not distinguish from a
# clean run. Emit an honest "incomplete" report instead. Uses printf with %d on
# already-validated integers, so it works even if jq is what broke.
#
# The disable below is a false positive: this function IS invoked, indirectly,
# by the `trap ... EXIT` registered right after it. ShellCheck 0.11 loses that
# link once another function in the file calls `exit` unconditionally.
# shellcheck disable=SC2329
on_exit() {
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
