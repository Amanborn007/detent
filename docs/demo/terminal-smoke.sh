#!/usr/bin/env bash
# Replays the terminal demo's commands (docs/demo/terminal.tape) without vhs and fails if a key output line is missing.
# Offline: stub claude, gh, curator and ticket socket. DETENT_FORCE_TTY stands in for the terminal the tape has.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
export DEMO_TMP="$(mktemp -d "${TMPDIR:-/tmp}/detent-term.XXXXXX")"
trap 'rm -rf "$DEMO_TMP"' EXIT
source "$here/terminal-env.sh" || exit 1
export DETENT_FORCE_TTY=1
fail=0
expect() { # <label> <regex> <text>
  if printf '%s\n' "$3" | grep -Eq -- "$2"; then echo "ok   $1"; else echo "FAIL $1: no line matching /$2/" >&2; printf '%s\n' "$3" >&2; fail=1; fi
}
step() { # <var> <stdin> <command...>: capture stdout+stderr in $var, require exit 0 unless DETENT_RC says otherwise
  local var="$1" input="$2"; shift 2
  local text rc
  text="$(printf '%s' "$input" | "$@" 2>&1)"; rc=$?
  printf -v "$var" '%s' "$text"
  if [ "$rc" -ne "${DETENT_RC:-0}" ]; then echo "FAIL $*: exit $rc, wanted ${DETENT_RC:-0}" >&2; printf '%s\n' "$text" >&2; fail=1; fi
}

DETENT_RC=1 step doctor "" detent doctor
expect "doctor flags the missing stack.yaml" '^FAIL stack\.yaml' "$doctor"
expect "doctor passes the checks that are ready" '^PASS gh push access: .*acme/widgets' "$doctor"

step start "" detent start acme/widgets#1
expect "start prints one index line" '^index: build: [0-9]+ files, [0-9]+ symbols, tagger regex' "$start"
expect "start creates the run" '^Run .*-acme-widgets-1 \(acme/widgets#1\)' "$start"
step status "" detent status
expect "status shows intake next" 'detent stage begin intake' "$status"

for stage in intake research plan; do
  step cont "y
" detent continue
  expect "continue runs $stage" "^continue: run .*one step \\($stage\\)" "$cont"
  expect "continue after $stage names a friendly verb" '^Next: .*detent (continue|decide|approve)' "$cont"
  if printf '%s\n' "$cont" | grep -q 'detent drive'; then echo "FAIL continue after $stage names detent drive" >&2; fail=1; fi
done
step status "" detent status
expect "status shows the plan waiting on the intent gate" 'plan  \(waiting on D-001\)' "$status"

step decide "" detent decide
expect "decide waits on the same gate" '^Next: still waiting on D-001' "$decide"
step approve "y
" detent approve
expect "approve asks first" 'with "approve"\? \[y/N\]' "$approve"
expect "approve moves the run on" '^Next: detent continue' "$approve"
expect "approve no longer shows the plan waiting on the answered gate" '^  [^ ] plan *$' "$approve"
expect "start has no en or em dash" '^Next: detent continue[:.] ' "$start"
if printf '%s\n' "$start$approve" | grep -q '[–—]'; then echo "FAIL friendly output contains an en or em dash" >&2; fail=1; fi
step cont "y
" detent continue
expect "continue closes the plan stage and hands implement to a person" '^Next: the plan is approved' "$cont"
expect "status shows plan done" '✓ plan' "$(detent status 2>&1)"

[ "$fail" -eq 0 ] && echo "terminal smoke ok"
exit "$fail"
