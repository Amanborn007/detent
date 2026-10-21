#!/usr/bin/env bash
# test-cold-resume-warn.sh — offline tests for hooks/cold-resume-warn.mjs.
#
# Proves:
#   1. A resume whose last assistant turn is over an hour old prints the warning.
#   2. COLD_RESUME_WARN=off kill switch: same payload, prints nothing.
#   3. A resume inside the hour prints nothing.
#   4. A `startup` session prints nothing, however old the transcript.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../cold-resume-warn.mjs"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cold-resume-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# transcript <name> <minutes-ago> -> path to a one-record transcript
transcript() {
  local ts
  ts="$(node -e "console.log(new Date(Date.now() - $2 * 60000).toISOString())")"
  printf '{"type":"assistant","timestamp":"%s"}\n' "$ts" > "$TMP/$1.jsonl"
  echo "$TMP/$1.jsonl"
}
payload() { printf '{"source":"%s","transcript_path":"%s"}' "$1" "$2"; }

old="$(transcript old 180)"
new="$(transcript new 10)"

out="$(payload resume "$old" | env -u COLD_RESUME_WARN node "$HOOK")"
[[ "$out" == *"COLD RESUME"* ]] || fail "1: cold resume did not warn: $out"
pass=$((pass+1))

out="$(payload resume "$old" | COLD_RESUME_WARN=off node "$HOOK")"
[ -z "$out" ] || fail "2: COLD_RESUME_WARN=off still printed: $out"
pass=$((pass+1))

out="$(payload resume "$new" | env -u COLD_RESUME_WARN node "$HOOK")"
[ -z "$out" ] || fail "3: warm resume printed: $out"
pass=$((pass+1))

out="$(payload startup "$old" | env -u COLD_RESUME_WARN node "$HOOK")"
[ -z "$out" ] || fail "4: startup printed: $out"
pass=$((pass+1))

echo "PASS: $pass/4 cold-resume-warn tests"
