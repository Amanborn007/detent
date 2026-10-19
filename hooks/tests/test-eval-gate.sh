#!/usr/bin/env bash
# test-eval-gate.sh — offline tests for hooks/eval-gate.sh (no network, no
# real push/PR; everything runs against a scratch local git repo).
#
# Proves:
#   1. EVAL_GATE=off kill switch: exits 0, prints nothing, even on a matching
#      payload + a diff that touches engine-eval-relevant paths.
#   2. OWL_RUN set (background/unattended) self-disables the same way.
#   3. A matching `git push` whose merge-base diff touches an eval-relevant
#      path (engine/cli/**) emits hookSpecificOutput.additionalContext
#      mentioning `engine eval --changed`.
#   4. A second invocation for the SAME head sha emits nothing (dedup marker).
#   5. A non-matching command (no git push / gh pr create) prints nothing.
#   6. A matching `git push` whose diff touches only eval-irrelevant paths
#      (e.g. a top-level README) prints nothing.
#   7. A matching `git push` touching only evals/cases/x.json (the harness's
#      own case data, LOW-5) still emits the nudge — evals/** and
#      engine/eval/** must be in the glob-root alternation, same as
#      evals/config.yaml's context-adherence suite.
#   8. CLAUDE_JOB_DIR set (background job) self-disables: exits 0, silent,
#      even on an otherwise-matching payload (doctrine-required kill switch).
#   9. EVAL_BLOCKING=on nudge wording says "blocking" (env wins over config).
#  10. DETENT_ROOT's evals/config.yaml with `gate: {mode: blocking}` (no env
#      override) makes the nudge wording say "blocking" too.
#  11. EVAL_BLOCKING=off nudge wording says "advisory" even when the same
#      DETENT_ROOT config has `gate.mode: blocking` — env override wins.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../eval-gate.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/eval-gate-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# mk_repo <name> -> path to a fresh repo with a `main` branch (one commit) and
# a `feature` branch checked out with one additional commit touching $1's path.
mk_repo() {
  local name="$1"
  local touched_path="$2"
  local dir="$TMP/$name"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "eval-gate-test@example.com"
  git -C "$dir" config user.name "eval-gate-test"
  mkdir -p "$dir/$(dirname "README.md")"
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

run_hook() { # env-prefixed invocation; sets HOOK_RC, echoes stdout
  local input="$1"; shift
  set +e
  OUT="$(env -u CLAUDE_JOB_DIR -u OWL_RUN "$@" bash "$HOOK" <<<"$input")"
  HOOK_RC=$?
  set -e
}

# --- 1. EVAL_GATE=off kill switch --------------------------------------------
REPO1="$(mk_repo repo1 engine/cli/newthing.mjs)"
DETENT1="$TMP/detent1"; mkdir -p "$DETENT1"
IN1="$(payload_for "$REPO1" "git push origin feature")"
run_hook "$IN1" DETENT_ROOT="$DETENT1" EVAL_GATE=off
[ "$HOOK_RC" -eq 0 ] || fail "EVAL_GATE=off should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "EVAL_GATE=off should print nothing, got: $OUT"
echo "ok 1 - EVAL_GATE=off kill switch: exit 0, silent"; pass=$((pass+1))

# --- 2. OWL_RUN self-disable --------------------------------------------------
REPO2="$(mk_repo repo2 engine/cli/newthing2.mjs)"
DETENT2="$TMP/detent2"; mkdir -p "$DETENT2"
IN2="$(payload_for "$REPO2" "git push origin feature")"
run_hook "$IN2" DETENT_ROOT="$DETENT2" OWL_RUN=1
[ "$HOOK_RC" -eq 0 ] || fail "OWL_RUN set should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "OWL_RUN set should print nothing, got: $OUT"
echo "ok 2 - OWL_RUN background self-disable: exit 0, silent"; pass=$((pass+1))

# --- 3. matching push + eval-relevant diff -> additionalContext nudge -------
REPO3="$(mk_repo repo3 engine/cli/newthing3.mjs)"
DETENT3="$TMP/detent3"; mkdir -p "$DETENT3"
IN3="$(payload_for "$REPO3" "git push origin feature")"
run_hook "$IN3" DETENT_ROOT="$DETENT3"
[ "$HOOK_RC" -eq 0 ] || fail "matching push should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "matching push touching engine/cli/** should emit a nudge, got nothing"
ctx="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx" == *"engine eval --changed"* ]] || fail "additionalContext does not mention 'engine eval --changed': $ctx"
[ "$(jq -r '.suppressOutput' <<<"$OUT")" = "true" ] || fail "suppressOutput should be true"
echo "ok 3 - matching push + eval-relevant diff emits additionalContext nudge"; pass=$((pass+1))

# --- 4. dedup: same repo + head sha does not nudge twice --------------------
run_hook "$IN3" DETENT_ROOT="$DETENT3"
[ "$HOOK_RC" -eq 0 ] || fail "repeat invocation should still exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "repeat invocation for the same head sha should be deduped, got: $OUT"
echo "ok 4 - dedup marker prevents a second emission for the same head sha"; pass=$((pass+1))

# --- 5. non-matching command prints nothing ----------------------------------
DETENT5="$TMP/detent5"; mkdir -p "$DETENT5"
IN5="$(payload_for "$REPO3" "ls -la")"
run_hook "$IN5" DETENT_ROOT="$DETENT5"
[ "$HOOK_RC" -eq 0 ] || fail "non-matching command should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "non-matching command should print nothing, got: $OUT"
echo "ok 5 - non-matching command prints nothing"; pass=$((pass+1))

# --- 6. matching push, but diff touches only eval-irrelevant paths ----------
REPO6="$(mk_repo repo6 docs/unrelated-notes.md)"
DETENT6="$TMP/detent6"; mkdir -p "$DETENT6"
IN6="$(payload_for "$REPO6" "git push origin feature")"
run_hook "$IN6" DETENT_ROOT="$DETENT6"
[ "$HOOK_RC" -eq 0 ] || fail "irrelevant-diff push should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "push touching only docs/** should print nothing, got: $OUT"
echo "ok 6 - matching push with only eval-irrelevant paths changed prints nothing"; pass=$((pass+1))

# --- 7. matching push touching only evals/cases/x.json -> still nudges -----
REPO7="$(mk_repo repo7 evals/cases/x.json)"
DETENT7="$TMP/detent7"; mkdir -p "$DETENT7"
IN7="$(payload_for "$REPO7" "git push origin feature")"
run_hook "$IN7" DETENT_ROOT="$DETENT7"
[ "$HOOK_RC" -eq 0 ] || fail "evals/cases/x.json push should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "push touching only evals/cases/x.json should emit a nudge, got nothing"
ctx7="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx7" == *"engine eval --changed"* ]] || fail "additionalContext does not mention 'engine eval --changed': $ctx7"
echo "ok 7 - matching push touching only evals/cases/x.json emits the nudge"; pass=$((pass+1))

# --- 8. CLAUDE_JOB_DIR self-disable ------------------------------------------
REPO8="$(mk_repo repo8 engine/cli/newthing8.mjs)"
DETENT8="$TMP/detent8"; mkdir -p "$DETENT8"
IN8="$(payload_for "$REPO8" "git push origin feature")"
run_hook "$IN8" DETENT_ROOT="$DETENT8" CLAUDE_JOB_DIR=/x
[ "$HOOK_RC" -eq 0 ] || fail "CLAUDE_JOB_DIR set should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "CLAUDE_JOB_DIR set should print nothing, got: $OUT"
echo "ok 8 - CLAUDE_JOB_DIR background self-disable: exit 0, silent"; pass=$((pass+1))

# --- 9. EVAL_BLOCKING=on -> nudge wording says "blocking" --------------------
REPO9="$(mk_repo repo9 engine/cli/newthing9.mjs)"
DETENT9="$TMP/detent9"; mkdir -p "$DETENT9"
IN9="$(payload_for "$REPO9" "git push origin feature")"
run_hook "$IN9" DETENT_ROOT="$DETENT9" EVAL_BLOCKING=on
[ "$HOOK_RC" -eq 0 ] || fail "EVAL_BLOCKING=on push should exit 0, got $HOOK_RC"
ctx9="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx9" == *"blocking"* ]] || fail "EVAL_BLOCKING=on should say 'blocking': $ctx9"
echo "ok 9 - EVAL_BLOCKING=on nudge wording says blocking"; pass=$((pass+1))

# --- 10. DETENT_ROOT config gate.mode: blocking -> nudge says "blocking" ---
REPO10="$(mk_repo repo10 engine/cli/newthing10.mjs)"
DETENT10="$TMP/detent10"; mkdir -p "$DETENT10/evals"
cat >"$DETENT10/evals/config.yaml" <<'YAML'
band: 0.05
k: 1
judge_max_cases: 5

gate:
  mode: blocking
  burn_in_prs: 5
YAML
IN10="$(payload_for "$REPO10" "git push origin feature")"
run_hook "$IN10" DETENT_ROOT="$DETENT10"
[ "$HOOK_RC" -eq 0 ] || fail "config gate.mode:blocking push should exit 0, got $HOOK_RC"
ctx10="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx10" == *"blocking"* ]] || fail "config gate.mode:blocking should say 'blocking': $ctx10"
echo "ok 10 - DETENT_ROOT config gate.mode:blocking nudge wording says blocking"; pass=$((pass+1))

# --- 11. EVAL_BLOCKING=off overrides a blocking config -> nudge says "advisory" ---
REPO11="$(mk_repo repo11 engine/cli/newthing11.mjs)"
DETENT11="$TMP/detent11"; mkdir -p "$DETENT11/evals"
cat >"$DETENT11/evals/config.yaml" <<'YAML'
band: 0.05
k: 1
judge_max_cases: 5

gate:
  mode: blocking
  burn_in_prs: 5
YAML
IN11="$(payload_for "$REPO11" "git push origin feature")"
run_hook "$IN11" DETENT_ROOT="$DETENT11" EVAL_BLOCKING=off
[ "$HOOK_RC" -eq 0 ] || fail "EVAL_BLOCKING=off push should exit 0, got $HOOK_RC"
ctx11="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx11" == *"advisory"* ]] || fail "EVAL_BLOCKING=off should say 'advisory': $ctx11"
echo "ok 11 - EVAL_BLOCKING=off overrides a blocking config: nudge says advisory"; pass=$((pass+1))

echo "test-eval-gate: all $pass tests passed"
