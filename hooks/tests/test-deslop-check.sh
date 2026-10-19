#!/usr/bin/env bash
# test-deslop-check.sh — offline tests for hooks/deslop-check.sh (no network,
# no real push/PR; everything runs against a scratch local git repo).
#
# Proves:
#   1. DESLOP=off kill switch: exits 0, prints nothing, even on a matching
#      payload + a diff that touches a code file.
#   2. CLAUDE_JOB_DIR set (headless/job run) self-disables the same way.
#   3. PR_AUTOREVIEW=off self-disables the same way (referee's own fix pushes
#      use `PR_AUTOREVIEW=off git push`).
#   4. A matching `git push` whose merge-base diff touches a code file emits
#      hookSpecificOutput.additionalContext mentioning `/deslop`.
#   5. A second invocation for the SAME head sha emits nothing (dedup marker).
#   6. A non-matching command (no git push) prints nothing.
#   7. A matching `git push` whose diff touches only a docs (`*.md`) file
#      prints nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../deslop-check.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/deslop-check-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# mk_repo <name> <touched_path> -> path to a fresh repo with a `main` branch
# (one commit) and a `feature` branch checked out with one additional commit
# touching $2's path.
mk_repo() {
  local name="$1"
  local touched_path="$2"
  local dir="$TMP/$name"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "deslop-check-test@example.com"
  git -C "$dir" config user.name "deslop-check-test"
  echo "seed" >"$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m "seed"
  git -C "$dir" checkout -q -b feature
  mkdir -p "$dir/$(dirname "$touched_path")"
  echo "change" >"$dir/$touched_path"
  git -C "$dir" add "$touched_path"
  git -C "$dir" commit -q -m "touch $touched_path"
  printf '%s' "$dir"
}

payload_for() {
  local cwd="$1" cmd="$2"
  jq -cn --arg cwd "$cwd" --arg cmd "$cmd" '{cwd:$cwd, tool_input:{command:$cmd}}'
}

# run_hook <payload> [ENV=val ...] -- always clears CLAUDE_JOB_DIR / OWL_RUN /
# PR_AUTOREVIEW from the AMBIENT environment first (this test may itself be
# running inside a job/subagent), then applies the given overrides in order,
# so a test can explicitly re-set one of them to exercise its kill switch.
run_hook() {
  local input="$1"; shift
  set +e
  OUT="$(env -u CLAUDE_JOB_DIR -u OWL_RUN -u PR_AUTOREVIEW "$@" bash "$HOOK" <<<"$input")"
  HOOK_RC=$?
  set -e
}

# --- 1. DESLOP=off kill switch -----------------------------------------------
REPO1="$(mk_repo repo1 src/foo.js)"
DETENT1="$TMP/detent1"; mkdir -p "$DETENT1"
IN1="$(payload_for "$REPO1" "git push origin feature")"
run_hook "$IN1" DETENT_ROOT="$DETENT1" DESLOP=off
[ "$HOOK_RC" -eq 0 ] || fail "DESLOP=off should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "DESLOP=off should print nothing, got: $OUT"
echo "ok 1 - DESLOP=off kill switch: exit 0, silent"; pass=$((pass+1))

# --- 2. CLAUDE_JOB_DIR set self-disable ---------------------------------------
REPO2="$(mk_repo repo2 src/foo2.js)"
DETENT2="$TMP/detent2"; mkdir -p "$DETENT2"
IN2="$(payload_for "$REPO2" "git push origin feature")"
run_hook "$IN2" DETENT_ROOT="$DETENT2" CLAUDE_JOB_DIR=/tmp/fake-job
[ "$HOOK_RC" -eq 0 ] || fail "CLAUDE_JOB_DIR set should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "CLAUDE_JOB_DIR set should print nothing, got: $OUT"
echo "ok 2 - CLAUDE_JOB_DIR self-disable: exit 0, silent"; pass=$((pass+1))

# --- 3. PR_AUTOREVIEW=off self-disable ----------------------------------------
REPO3="$(mk_repo repo3 src/foo3.js)"
DETENT3="$TMP/detent3"; mkdir -p "$DETENT3"
IN3="$(payload_for "$REPO3" "git push origin feature")"
run_hook "$IN3" DETENT_ROOT="$DETENT3" PR_AUTOREVIEW=off
[ "$HOOK_RC" -eq 0 ] || fail "PR_AUTOREVIEW=off should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "PR_AUTOREVIEW=off should print nothing, got: $OUT"
echo "ok 3 - PR_AUTOREVIEW=off self-disable: exit 0, silent"; pass=$((pass+1))

# --- 4. matching push + code diff -> additionalContext nudge mentioning /deslop
REPO4="$(mk_repo repo4 src/foo4.js)"
DETENT4="$TMP/detent4"; mkdir -p "$DETENT4"
IN4="$(payload_for "$REPO4" "git push origin feature")"
run_hook "$IN4" DETENT_ROOT="$DETENT4"
[ "$HOOK_RC" -eq 0 ] || fail "matching push should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "matching push touching src/foo4.js should emit a nudge, got nothing"
ctx="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx" == *"/deslop"* ]] || fail "additionalContext does not mention /deslop: $ctx"
[ "$(jq -r '.suppressOutput' <<<"$OUT")" = "true" ] || fail "suppressOutput should be true"
echo "ok 4 - matching push + code diff emits additionalContext nudge mentioning /deslop"; pass=$((pass+1))

# --- 5. dedup: same repo + head sha does not nudge twice ---------------------
run_hook "$IN4" DETENT_ROOT="$DETENT4"
[ "$HOOK_RC" -eq 0 ] || fail "repeat invocation should still exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "repeat invocation for the same head sha should be deduped, got: $OUT"
echo "ok 5 - dedup marker prevents a second emission for the same head sha"; pass=$((pass+1))

# --- 6. non-matching command prints nothing ----------------------------------
DETENT6="$TMP/detent6"; mkdir -p "$DETENT6"
IN6="$(payload_for "$REPO4" "ls -la")"
run_hook "$IN6" DETENT_ROOT="$DETENT6"
[ "$HOOK_RC" -eq 0 ] || fail "non-matching command should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "non-matching command should print nothing, got: $OUT"
echo "ok 6 - non-matching command prints nothing"; pass=$((pass+1))

# --- 7. matching push, diff touches only a docs (*.md) file -----------------
REPO7="$(mk_repo repo7 docs/notes.md)"
DETENT7="$TMP/detent7"; mkdir -p "$DETENT7"
IN7="$(payload_for "$REPO7" "git push origin feature")"
run_hook "$IN7" DETENT_ROOT="$DETENT7"
[ "$HOOK_RC" -eq 0 ] || fail "docs-only push should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "push touching only a *.md file should print nothing, got: $OUT"
echo "ok 7 - matching push with only a docs (*.md) diff prints nothing"; pass=$((pass+1))

echo "ok 1..$pass"
echo "test-deslop-check: all $pass tests passed"
