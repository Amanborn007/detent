#!/usr/bin/env bash
# Tests for check-curator-used.sh — runs the hook against synthetic session
# transcripts and asserts on its stdout / exit code.
#
#   ./test-check-curator-used.sh
#
# Exits non-zero on the first failed assertion.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../check-curator-used.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# --- transcript line builders -----------------------------------------------
user_prompt()   { printf '{"type":"user","message":{"role":"user","content":"%s"}}\n' "$1"; }
tool_write()    { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"%s","name":"Write","input":{"file_path":"%s"}}]}}\n' "$1" "$2"; }
tool_bash()     { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"%s","name":"Bash","input":{"command":"%s"}}]}}\n' "$1" "$2"; }
tool_exitplan() { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"%s","name":"ExitPlanMode","input":{"plan":"the plan"}}]}}\n' "$1"; }
tool_result()   { printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"%s","content":"ok"}]}}\n' "$1"; }
tool_error()    { printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"%s","is_error":true,"content":"The user does not want to proceed"}]}}\n' "$1"; }
asst_text()     { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$1"; }

payload() { # $1=transcript path, $2=stop_hook_active
  printf '{"session_id":"test","transcript_path":"%s","hook_event_name":"Stop","stop_hook_active":%s}' "$1" "$2"
}

# --- assertion helpers --------------------------------------------------------
# run_case NAME TRANSCRIPT_FILE STOP_ACTIVE EXPECT(block|allow)
run_case() {
  local name="$1" transcript="$2" stop_active="$3" expect="$4"
  local out rc decision
  out="$(payload "$transcript" "$stop_active" | bash "$HOOK" 2>"$WORK/stderr")"
  rc=$?
  if [ "$expect" = "block" ]; then
    decision="$(jq -r '.decision // empty' <<<"$out" 2>/dev/null)"
    if [ "$rc" -eq 0 ] && [ "$decision" = "block" ]; then
      echo "PASS: $name"; PASS=$((PASS+1))
    else
      echo "FAIL: $name — expected block, got rc=$rc out=<$out>"; FAIL=$((FAIL+1))
    fi
  else # allow
    if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
      echo "PASS: $name"; PASS=$((PASS+1))
    else
      echo "FAIL: $name — expected no output, got rc=$rc out=<$out>"; FAIL=$((FAIL+1))
    fi
  fi
}

# --- cases --------------------------------------------------------------------

# 1. Artifact written under .plans/, curator never opened -> block
T="$WORK/t1.jsonl"
{ user_prompt "research X and report"
  tool_write w1 "/repo/.plans/research-x.html"; tool_result w1
  asst_text "Here is the report."
} > "$T"
run_case "artifact-no-curator blocks" "$T" false block

# 2. Artifact written AND curator opened -> allow
T="$WORK/t2.jsonl"
{ user_prompt "research X and report"
  tool_write w1 "/repo/.plans/research-x.html"; tool_result w1
  tool_bash b1 "curator /repo/.plans/research-x.html"; tool_result b1
} > "$T"
run_case "artifact-with-curator allows" "$T" false allow

# 3. No artifact this turn -> allow
T="$WORK/t3.jsonl"
{ user_prompt "rename this variable"
  tool_write w1 "/repo/src/main.py"; tool_result w1
} > "$T"
run_case "no-artifact allows" "$T" false allow

# 4. stop_hook_active=true -> always allow (loop guard), even with artifact
T="$WORK/t4.jsonl"
{ user_prompt "research X"
  tool_write w1 "/repo/.plans/x.html"; tool_result w1
} > "$T"
run_case "stop_hook_active loop guard allows" "$T" true allow

# 5. Artifact written in a PREVIOUS turn only -> allow
T="$WORK/t5.jsonl"
{ user_prompt "research X"
  tool_write w1 "/repo/.plans/x.html"; tool_result w1
  tool_bash b1 "curator /repo/.plans/x.html"; tool_result b1
  user_prompt "thanks, now fix the typo in README"
  tool_write w2 "/repo/README.md"; tool_result w2
} > "$T"
run_case "previous-turn artifact allows" "$T" false allow

# 6. Plan approved via ExitPlanMode, no curator -> block
T="$WORK/t6.jsonl"
{ user_prompt "plan the migration"
  tool_exitplan e1; tool_result e1
  tool_write w1 "/repo/src/migrate.py"; tool_result w1
} > "$T"
run_case "approved-plan-no-curator blocks" "$T" false block

# 7. ExitPlanMode rejected (is_error result) -> allow
T="$WORK/t7.jsonl"
{ user_prompt "plan the migration"
  tool_exitplan e1; tool_error e1
  asst_text "Understood, revising the plan."
} > "$T"
run_case "rejected-plan allows" "$T" false allow

# 8. Approved plan followed by curator -> allow
T="$WORK/t8.jsonl"
{ user_prompt "plan the migration"
  tool_exitplan e1; tool_result e1
  tool_write w1 "/repo/.plans/migration.html"; tool_result w1
  tool_bash b1 "curator /repo/.plans/migration.html"; tool_result b1
} > "$T"
run_case "approved-plan-with-curator allows" "$T" false allow

# 9. Word 'curator' merely mentioned in a file path Write (not invoked) -> still block
T="$WORK/t9.jsonl"
{ user_prompt "research X"
  tool_write w1 "/repo/.plans/x.html"; tool_result w1
  tool_bash b1 "grep -r replan /repo/src"; tool_result b1
} > "$T"
run_case "unrelated-bash-still-blocks" "$T" false block

# 10. Missing transcript -> exit 1, stderr, no stdout
out="$(payload "$WORK/does-not-exist.jsonl" false | bash "$HOOK" 2>"$WORK/stderr10")"
rc=$?
if [ "$rc" -eq 1 ] && [ -z "$out" ] && grep -q "not readable" "$WORK/stderr10"; then
  echo "PASS: missing transcript errors non-blockingly"; PASS=$((PASS+1))
else
  echo "FAIL: missing transcript — rc=$rc out=<$out> stderr=<$(cat "$WORK/stderr10")>"; FAIL=$((FAIL+1))
fi

# 11. Garbage lines in transcript are ignored (resilience) -> block still works
T="$WORK/t11.jsonl"
{ user_prompt "research X"
  echo 'not json at all'
  tool_write w1 "/repo/.plans/x.html"; tool_result w1
} > "$T"
run_case "garbage-lines tolerated" "$T" false block

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
