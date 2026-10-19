#!/usr/bin/env bash
# Test harness for engine/owl/owl.sh, driven by the fake-claude stub.
# Proves: commit-on-success, reset-on-failure, no-op-is-failure, 3-failure
# kill switch, iteration cap, wall-clock cap, notes accumulation, stop-claim
# handling, contract-violation handling, dirty-tree refusal, morning
# artifact generation, the never-halt provisional decision journal
# (journal entry + [PROVISIONAL D-n] commit tag + morning-artifact section),
# and the permission-profile mechanism (default-profile resolution/rename
# fix, network-off-by-default config, bypass/blanket-Bash/bare-network
# profile guards, unknown-profile error).
set -u -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OWL="$HERE/../owl.sh"
FAKE="$HERE/fake-claude"
PROFILES_DIR="$HERE/../profiles"
WORK="${TMPDIR:-/tmp}/owl-tests-$$"
mkdir -p "$WORK"

PASS=0
FAIL=0
CURRENT_TEST=""

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); say "  ok: $*"; }
bad()  { FAIL=$((FAIL + 1)); say "  FAIL [$CURRENT_TEST]: $*"; }

assert_eq() { # $1=expected $2=actual $3=label
  if [[ "$1" == "$2" ]]; then ok "$3 == $1"; else bad "$3: expected '$1', got '$2'"; fi
}
assert_file_contains() { # $1=file $2=needle $3=label
  if grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3: '$2' not found in $1"; fi
}
assert_file_absent_str() { # $1=file $2=needle $3=label
  if grep -qF -- "$2" "$1" 2>/dev/null; then bad "$3: '$2' unexpectedly present in $1"; else ok "$3"; fi
}
assert_exists() { # $1=path $2=label
  if [[ -e "$1" ]]; then ok "$2"; else bad "$2: $1 does not exist"; fi
}
assert_absent() { # $1=path $2=label
  if [[ -e "$1" ]]; then bad "$2: $1 unexpectedly exists"; else ok "$2"; fi
}

new_case() { # $1=name -> sets CASE_DIR REPO FAKE_DIR; makes a git repo w/ one commit
  CURRENT_TEST="$1"
  say ""
  say "TEST: $1"
  CASE_DIR="$WORK/$1"
  REPO="$CASE_DIR/repo"
  FAKE_DIR="$CASE_DIR/fake"
  mkdir -p "$REPO" "$FAKE_DIR"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email test@example.invalid
  git -C "$REPO" config user.name "owl tests"
  git -C "$REPO" config commit.gpgsign false
  printf 'seed\n' > "$REPO/seed.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "init"
}

run_owl() { # extra owl.sh args after --; logs to $CASE_DIR/owl-stdout.log
  env OWL_CLAUDE_BIN="$FAKE" \
      FAKE_CLAUDE_DIR="$FAKE_DIR" \
      OWL_NO_CAFFEINATE=1 \
      "${EXTRA_ENV[@]:+${EXTRA_ENV[@]}}" \
      "$OWL" --repo "$REPO" "$@" \
      > "$CASE_DIR/owl-stdout.log" 2>&1
  OWL_EXIT=$?
  return 0
}
EXTRA_ENV=()

fake_calls()   { cat "$FAKE_DIR/iter.count" 2>/dev/null || printf '0'; }
argv_settings_value() { # $1=invocation number -> value of the argv element right after --settings
  awk '/^--settings$/{getline; print; exit}' "$FAKE_DIR/argv-$1.txt" 2>/dev/null
}
commit_count() { git -C "$REPO" rev-list --count HEAD; }
subject()      { git -C "$REPO" log --format=%s -n 1 "HEAD~$1" 2>/dev/null || printf 'MISSING'; }
run_log()      { ls "$REPO"/.owl/*/log 2>/dev/null | head -1; }
notes_file()   { ls "$REPO"/.owl/notes-*.md 2>/dev/null | head -1; }
artifact()     { ls "$REPO"/.plans/owl-review-*.html 2>/dev/null | head -1; }

# ---------------------------------------------------------------- T1
new_case "commit-on-success"
printf 'edit-success\nedit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "grow work.txt steadily" --max-iterations 2
assert_eq 0 "$OWL_EXIT" "exit code"
assert_eq 2 "$(fake_calls)" "claude invocations"
assert_eq 3 "$(commit_count)" "total commits (init + 2)"
assert_eq "owl 2: fake unit 2" "$(subject 0)" "HEAD subject"
assert_eq "owl 1: fake unit 1" "$(subject 1)" "HEAD~1 subject"
assert_eq "owl/grow-work-txt-steadily" "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" "branch name"
assert_file_contains "$REPO/work.txt" "iteration 2" "work.txt kept both edits"

# ---------------------------------------------------------------- T2
new_case "reset-on-failure"
printf 'edit-fail\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "reset check" --max-iterations 1
assert_eq 1 "$(commit_count)" "no new commits"
assert_absent "$REPO/work.txt" "junk file removed by reset+clean"
assert_eq "" "$(git -C "$REPO" status --porcelain -- ':(exclude).owl' ':(exclude).plans')" "tree clean after failure"
assert_exists "$(run_log)" "run log exists under .owl/<run>/log"

# ---------------------------------------------------------------- T3
new_case "noop-is-failure"
printf 'noop-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "noop check" --max-iterations 1
assert_eq 1 "$(commit_count)" "no commit for a no-op"
assert_file_contains "$(run_log)" "no-op" "run log flags the no-op as failure"

# ---------------------------------------------------------------- T4
new_case "three-failure-kill-switch"
printf 'fail\nfail\nfail\nfail\nfail\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "kill switch check" --max-iterations 8
assert_eq 3 "$(fake_calls)" "halted after exactly 3 failed iterations"
assert_file_contains "$(run_log)" "kill switch" "run log names the kill switch"
assert_eq 1 "$(commit_count)" "no commits made"

# ---------------------------------------------------------------- T5
new_case "iteration-cap"
printf 'edit-success\nedit-success\nedit-success\nedit-success\nedit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "cap check" --max-iterations 2
assert_eq 2 "$(fake_calls)" "stopped at iteration cap"
assert_eq 3 "$(commit_count)" "exactly 2 owl commits"

# ---------------------------------------------------------------- T6
new_case "notes-accumulation"
printf 'edit-success\nfail\nedit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "notes check" --max-iterations 3
NOTES="$(notes_file)"
assert_exists "$NOTES" "notes file exists"
assert_file_contains "$NOTES" "learning-1" "iteration 1 learnings recorded"
assert_file_contains "$NOTES" "learning-2" "failed-iteration learnings recorded too"
assert_file_contains "$NOTES" "learning-3" "iteration 3 learnings recorded"
assert_file_contains "$NOTES" "FAILURE" "failure outcome recorded"
assert_eq 3 "$(commit_count)" "2 commits (iteration 2 rolled back)"

# ---------------------------------------------------------------- T7
new_case "stop-claim-halts-unverified"
printf 'edit-success\nstop\nedit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "stop claim check" --max-iterations 8 --stop-when "work.txt contains final"
assert_eq 2 "$(fake_calls)" "halted right after the stop claim"
assert_eq 3 "$(commit_count)" "stop-claim iteration still committed"
assert_file_contains "$(run_log)" "UNVERIFIED" "stop claim logged as unverified"

# ---------------------------------------------------------------- T8
new_case "morning-artifact"
printf 'edit-success\nstop\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "artifact check" --max-iterations 8
ART="$(artifact)"
assert_exists "$ART" "morning review artifact generated in .plans/"
assert_file_contains "$ART" "UNVERIFIED" "artifact carries the unverified banner"
assert_file_contains "$ART" "data-plan-question" "artifact has curator decision blocks"
SHA_HEAD="$(git -C "$REPO" rev-parse --short HEAD)"
SHA_PREV="$(git -C "$REPO" rev-parse --short HEAD~1)"
assert_file_contains "$ART" "$SHA_HEAD" "artifact references commit $SHA_HEAD"
assert_file_contains "$ART" "$SHA_PREV" "artifact references commit $SHA_PREV"
assert_file_contains "$ART" "fake unit 1" "artifact carries iteration summary"
assert_file_absent_str "$ART" "<script" "artifact is static (no scripts of its own)"

# ---------------------------------------------------------------- T9
new_case "contract-violation-is-failure"
printf 'garbage\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "garbage check" --max-iterations 1
assert_eq 1 "$(commit_count)" "no commit on contract violation"
assert_file_contains "$(run_log)" "contract" "run log names the contract violation"

# ---------------------------------------------------------------- T10
new_case "dirty-tree-refusal"
printf 'edit-success\n' > "$FAKE_DIR/plan.txt"
printf 'uncommitted\n' > "$REPO/dirty.txt"
run_owl --objective "dirty check" --max-iterations 1
assert_eq 1 "$OWL_EXIT" "nonzero exit on dirty tree"
assert_eq 0 "$(fake_calls)" "claude never invoked"
assert_exists "$REPO/dirty.txt" "user's dirty file untouched"

# ---------------------------------------------------------------- T11
new_case "wall-clock-cap"
printf 'sleep-30\nedit-success\n' > "$FAKE_DIR/plan.txt"
EXTRA_ENV=(OWL_MAX_SECONDS=6)
run_owl --objective "wall clock check" --max-iterations 8
EXTRA_ENV=()
assert_eq 1 "$(fake_calls)" "second iteration never started"
assert_file_contains "$(run_log)" "wall-clock" "run log names the wall-clock cap"
assert_eq 1 "$(commit_count)" "killed iteration not committed"

# ---------------------------------------------------------------- T12
new_case "provisional-decision-journal"
printf 'edit-success\ndecide\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "decision journal check" --max-iterations 2
DEC="$(ls "$REPO"/.owl/*/decisions.jsonl 2>/dev/null | head -1)"
assert_exists "$DEC" "decisions.jsonl exists in the run dir"
assert_eq 1 "$(jq -s 'length' "$DEC")" "exactly one journal entry"
assert_eq "D-1" "$(jq -r '.id' "$DEC")" "entry id is D-1"
assert_eq 2 "$(jq -r '.iteration' "$DEC")" "entry records iteration 2"
for f in decision_needed options_considered provisional_choice rationale reversibility; do
  assert_eq true "$(jq --arg f "$f" 'has($f)' "$DEC")" "entry has field $f"
done
assert_eq "store the cache as a json file" "$(jq -r '.provisional_choice' "$DEC")" "provisional choice recorded"
assert_eq "owl 2: fake unit 2 (with decision) [PROVISIONAL D-1]" "$(subject 0)" "commit tagged [PROVISIONAL D-1]"
assert_eq "owl 1: fake unit 1" "$(subject 1)" "decision-free commit stays untagged"
assert_file_contains "$(notes_file)" "D-1" "notes carry the provisional decision id"
assert_file_contains "$REPO"/.owl/*/prompt-1.txt "provisional_decisions" "iteration prompt carries the never-halt contract"
ART="$(artifact)"
assert_exists "$ART" "morning artifact generated"
assert_file_contains "$ART" "Decisions I made for you" "artifact renders the decisions section"
assert_file_contains "$ART" "store the cache as a json file" "artifact shows the provisional choice"
assert_file_contains "$ART" 'data-plan-question="decision-D-1"' "decision is a curator question block"
assert_file_contains "$ART" 'data-plan-option="Accept"' "decision has an Accept option"
assert_file_contains "$ART" 'data-plan-option="Pivot"' "decision has a Pivot option"
DEC_LINE="$(grep -n 'Decisions I made for you' "$ART" | head -1 | cut -d: -f1)"
ITER_LINE="$(grep -n 'Iteration 1' "$ART" | head -1 | cut -d: -f1)"
if [[ -n "$DEC_LINE" && -n "$ITER_LINE" && "$DEC_LINE" -lt "$ITER_LINE" ]]; then
  ok "decisions section renders above the iteration cards"
else
  bad "decisions section not above iteration cards (decisions@${DEC_LINE:-missing}, iter@${ITER_LINE:-missing})"
fi

# ---------------------------------------------------------------- T13
new_case "rolled-back-decision-not-journaled"
printf 'decide-fail\nedit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "rolled back decision check" --max-iterations 2
DEC="$(ls "$REPO"/.owl/*/decisions.jsonl 2>/dev/null | head -1)"
if [[ -z "$DEC" || "$(jq -s 'length' "$DEC" 2>/dev/null || printf 0)" == "0" ]]; then
  ok "failed iteration's decision not journaled"
else
  bad "decision journaled despite rollback: $(cat "$DEC")"
fi
assert_file_contains "$(run_log)" "dropped with the rollback" "run log flags the dropped decision"
assert_eq "owl 2: fake unit 2" "$(subject 0)" "later commit untagged"
ART="$(artifact)"
assert_file_absent_str "$ART" "Decisions I made for you" "no decisions section when journal is empty"

# ---------------------------------------------------------------- T14
new_case "default-profile-resolution"
printf 'edit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "profile resolution check" --max-iterations 1
assert_eq 0 "$OWL_EXIT" "exit code (re-proves the nightly-settings.json rename fix)"
assert_file_contains "$(run_log)" "profile: default" "run log records profile: default"
SETTINGS_ARG="$(argv_settings_value 1)"
case "$SETTINGS_ARG" in
  */profiles/default.json) ok "argv element after --settings resolves to profiles/default.json ($SETTINGS_ARG)" ;;
  *) bad "argv element after --settings should end in profiles/default.json, got '$SETTINGS_ARG'" ;;
esac

# ---------------------------------------------------------------- T15
CURRENT_TEST="network-off-by-default"
say ""
say "TEST: $CURRENT_TEST"
DEFAULT_PROFILE="$PROFILES_DIR/default.json"
assert_exists "$DEFAULT_PROFILE" "profiles/default.json exists"
for needle in WebFetch WebSearch "Bash(curl*)" "Bash(wget*)" "Bash(ssh*)" "Bash(nc*)"; do
  if jq -e --arg n "$needle" '.permissions.deny | index($n) != null' "$DEFAULT_PROFILE" >/dev/null 2>&1; then
    ok "deny contains $needle"
  else
    bad "deny missing $needle"
  fi
done
if jq -e '(.permissions.allow // []) | map(select(startswith("WebFetch") or startswith("WebSearch"))) | length == 0' "$DEFAULT_PROFILE" >/dev/null 2>&1; then
  ok "allow contains no WebFetch/WebSearch entries of any form"
else
  bad "allow unexpectedly contains a WebFetch/WebSearch entry"
fi

# ---------------------------------------------------------------- T16
new_case "profile-guard-bypass"
printf 'edit-success\n' > "$FAKE_DIR/plan.txt"
BYPASS_FILE="$CASE_DIR/bypass-settings.json"
jq -n '{permissions: {defaultMode: "bypassPermissions", allow: [], deny: []}}' > "$BYPASS_FILE"
run_owl --objective "bypass guard check" --max-iterations 1 --settings-file "$BYPASS_FILE"
assert_eq 1 "$OWL_EXIT" "nonzero exit on a bypassPermissions profile"
assert_eq 0 "$(fake_calls)" "claude never invoked"
assert_file_contains "$CASE_DIR/owl-stdout.log" "bypassPermissions" "stderr names the bypass rule"

# ---------------------------------------------------------------- T17
new_case "profile-guard-bare-network"
printf 'edit-success\n' > "$FAKE_DIR/plan.txt"
NET_FILE="$CASE_DIR/bare-net-settings.json"
jq -n '{permissions: {allow: ["Read", "WebFetch"], deny: []}}' > "$NET_FILE"
run_owl --objective "bare network guard check" --max-iterations 1 --settings-file "$NET_FILE"
assert_eq 1 "$OWL_EXIT" "nonzero exit on bare WebFetch in allow"
assert_eq 0 "$(fake_calls)" "claude never invoked"
assert_file_contains "$CASE_DIR/owl-stdout.log" "prefix-scoped" "stderr names the prefix-scoping rule"

# ---------------------------------------------------------------- T18
new_case "unknown-profile"
printf 'edit-success\n' > "$FAKE_DIR/plan.txt"
run_owl --objective "unknown profile check" --max-iterations 1 --profile nope
assert_eq 1 "$OWL_EXIT" "nonzero exit for an unknown profile"
assert_eq 0 "$(fake_calls)" "claude never invoked"
assert_file_contains "$CASE_DIR/owl-stdout.log" "default" "error lists available profile names (default)"
assert_file_contains "$CASE_DIR/owl-stdout.log" "example-net-allowlist" "error lists available profile names (example-net-allowlist)"

# ---------------------------------------------------------------- summary
say ""
say "================================"
say "PASS: $PASS  FAIL: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  say "RESULT: FAIL"
  exit 1
fi
say "RESULT: PASS"
rm -rf "$WORK"
exit 0
