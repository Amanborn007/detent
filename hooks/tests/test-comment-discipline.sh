#!/usr/bin/env bash
# test-comment-discipline.sh — offline tests for hooks/comment-discipline.sh
# (no network, no git, no real writes outside a scratch DETENT_ROOT).
#
# Proves:
#   1. COMMENT_DISCIPLINE=off kill switch: exits 0, prints nothing.
#   2. A markdown file path emits nothing (documents have no code comments).
#   3. A first code-ish Write emits hookSpecificOutput.additionalContext
#      carrying the standard, with suppressOutput true.
#   4. A second Write in the SAME session emits nothing (dedup marker).
#   5. A Write in a DIFFERENT session emits again.
#   6. Empty / malformed stdin exits 0 in silence.
#   7. CLAUDE_JOB_DIR set STILL emits — the deliberate divergence from every
#      sibling hook. This test exists so nobody "fixes" the hook to match them.
#   8. OWL_RUN set STILL emits, for the same reason.
#   9. An Edit-shaped payload (new_string, no content) is handled like a Write.
#  10. Comment-bearing markup/config that is NOT skipped: *.html (HTML comments,
#      embedded <script>) and *.yaml (comment syntax) both emit. *.json, which
#      has no comment syntax, stays skipped. Pins the gate against a
#      well-meaning "markup isn't code" widening of the skip list.
#  11. SessionStart emits with hookEventName "SessionStart" and no tool_input —
#      this is what covers a session whose FIRST and only Write already
#      contains its comments, which a PostToolUse hook structurally cannot.
#  12. The two events share ONE dedup marker: after SessionStart, that
#      agent's first code Write stays silent. Exactly one injection per
#      agent, whichever event got there first.
#  13. A SUBAGENT — same session_id as the parent, different transcript_path —
#      still gets the rule after the parent's SessionStart consumed its own
#      marker. This is the regression guard: keyed on session_id alone, the
#      parent would starve every subagent, which is precisely the population
#      the PostToolUse event exists to reach.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../comment-discipline.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/comment-discipline-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# A phrase from the injected standard that must survive any rewording pass.
CANON="never restate what the code already says"

# write_payload <file_path> <session_id>
write_payload() {
  jq -cn --arg fp "$1" --arg sid "$2" \
    '{session_id:$sid, tool_name:"Write", tool_input:{file_path:$fp, content:"x"}}'
}

# edit_payload <file_path> <session_id>
edit_payload() {
  jq -cn --arg fp "$1" --arg sid "$2" \
    '{session_id:$sid, tool_name:"Edit", tool_input:{file_path:$fp, old_string:"a", new_string:"b"}}'
}

# run_hook <payload> [ENV=val ...] -- always clears CLAUDE_JOB_DIR / OWL_RUN
# from the AMBIENT environment first (this test may itself be running inside a
# background job), then applies the given overrides in order, so a test can
# explicitly re-set one of them to exercise the no-self-disable guarantee.
run_hook() {
  local input="$1"; shift
  set +e
  OUT="$(env -u CLAUDE_JOB_DIR -u OWL_RUN "$@" bash "$HOOK" <<<"$input")"
  HOOK_RC=$?
  set -e
}

# --- 1. COMMENT_DISCIPLINE=off kill switch -----------------------------------
DETENT1="$TMP/detent1"; mkdir -p "$DETENT1"
run_hook "$(write_payload src/foo.ts sess-1)" DETENT_ROOT="$DETENT1" COMMENT_DISCIPLINE=off
[ "$HOOK_RC" -eq 0 ] || fail "COMMENT_DISCIPLINE=off should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "COMMENT_DISCIPLINE=off should print nothing, got: $OUT"
echo "ok 1 - COMMENT_DISCIPLINE=off kill switch: exit 0, silent"; pass=$((pass+1))

# --- 2. markdown path is skipped ---------------------------------------------
DETENT2="$TMP/detent2"; mkdir -p "$DETENT2"
run_hook "$(write_payload docs/notes.md sess-2)" DETENT_ROOT="$DETENT2"
[ "$HOOK_RC" -eq 0 ] || fail "markdown path should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "markdown path should print nothing, got: $OUT"
echo "ok 2 - a *.md path emits nothing"; pass=$((pass+1))

# --- 3. first code-ish write emits the standard ------------------------------
DETENT3="$TMP/detent3"; mkdir -p "$DETENT3"
IN3="$(write_payload src/foo.ts sess-3)"
run_hook "$IN3" DETENT_ROOT="$DETENT3"
[ "$HOOK_RC" -eq 0 ] || fail "code-ish write should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "first code-ish write should emit the standard, got nothing"
ctx="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx" == *"$CANON"* ]] || fail "additionalContext missing the canonical phrase: $ctx"
[[ "$ctx" == *"ticket key"* ]] || fail "additionalContext missing the ticket-key escape hatch: $ctx"
[[ "$ctx" == *"NOT slop"* ]] || fail "additionalContext missing the doc-comment carve-out: $ctx"
[[ "$ctx" == *"COMMENT_DISCIPLINE=off"* ]] || fail "additionalContext should name its kill switch: $ctx"
[ "$(jq -r '.hookSpecificOutput.hookEventName' <<<"$OUT")" = "PostToolUse" ] \
  || fail "hookEventName should be PostToolUse"
[ "$(jq -r '.suppressOutput' <<<"$OUT")" = "true" ] || fail "suppressOutput should be true"
echo "ok 3 - first code-ish write emits the standard (why-only + ticket hatch + doc carve-out)"; pass=$((pass+1))

# --- 4. dedup: same session does not emit twice ------------------------------
run_hook "$(write_payload src/bar.ts sess-3)" DETENT_ROOT="$DETENT3"
[ "$HOOK_RC" -eq 0 ] || fail "repeat write should still exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "second write in the same session should be deduped, got: $OUT"
echo "ok 4 - dedup marker prevents a second emission in the same session"; pass=$((pass+1))

# --- 5. a different session emits again --------------------------------------
run_hook "$(write_payload src/baz.ts sess-OTHER)" DETENT_ROOT="$DETENT3"
[ "$HOOK_RC" -eq 0 ] || fail "new-session write should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "a different session should get the standard, got nothing"
echo "ok 5 - a different session_id emits again"; pass=$((pass+1))

# --- 6. empty / malformed stdin is silent ------------------------------------
DETENT6="$TMP/detent6"; mkdir -p "$DETENT6"
run_hook "" DETENT_ROOT="$DETENT6"
[ "$HOOK_RC" -eq 0 ] || fail "empty stdin should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "empty stdin should print nothing, got: $OUT"
run_hook "not json at all" DETENT_ROOT="$DETENT6"
[ "$HOOK_RC" -eq 0 ] || fail "malformed stdin should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "malformed stdin should print nothing, got: $OUT"
echo "ok 6 - empty and malformed stdin both exit 0 in silence"; pass=$((pass+1))

# --- 7. CLAUDE_JOB_DIR set STILL emits (deliberate divergence) ---------------
DETENT7="$TMP/detent7"; mkdir -p "$DETENT7"
run_hook "$(write_payload src/foo.ts sess-7)" DETENT_ROOT="$DETENT7" CLAUDE_JOB_DIR=/tmp/fake-job
[ "$HOOK_RC" -eq 0 ] || fail "CLAUDE_JOB_DIR set should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "CLAUDE_JOB_DIR must NOT disable this hook — headless runs write code too"
echo "ok 7 - CLAUDE_JOB_DIR set still emits (no self-disable, by design)"; pass=$((pass+1))

# --- 8. OWL_RUN set STILL emits ----------------------------------------------
DETENT8="$TMP/detent8"; mkdir -p "$DETENT8"
run_hook "$(write_payload src/foo.ts sess-8)" DETENT_ROOT="$DETENT8" OWL_RUN=1
[ "$HOOK_RC" -eq 0 ] || fail "OWL_RUN set should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "OWL_RUN must NOT disable this hook — owl loops write code too"
echo "ok 8 - OWL_RUN set still emits (no self-disable, by design)"; pass=$((pass+1))

# --- 9. Edit-shaped payload behaves like a Write -----------------------------
DETENT9="$TMP/detent9"; mkdir -p "$DETENT9"
run_hook "$(edit_payload src/foo.go sess-9)" DETENT_ROOT="$DETENT9"
[ "$HOOK_RC" -eq 0 ] || fail "Edit payload should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "an Edit of a code file should emit the standard, got nothing"
echo "ok 9 - an Edit-shaped payload emits the standard"; pass=$((pass+1))

# --- 10. comment-bearing markup/config is NOT skipped ------------------------
DETENT10="$TMP/detent10"; mkdir -p "$DETENT10"
run_hook "$(write_payload web/index.html sess-10a)" DETENT_ROOT="$DETENT10"
[ -n "$OUT" ] || fail "*.html carries HTML comments and embedded <script> — must NOT be skipped"
run_hook "$(write_payload deploy/service.yaml sess-10b)" DETENT_ROOT="$DETENT10"
[ -n "$OUT" ] || fail "*.yaml has comment syntax — must NOT be skipped"
run_hook "$(write_payload docs/page.mdx sess-10d)" DETENT_ROOT="$DETENT10"
[ -n "$OUT" ] || fail "*.mdx embeds JSX and carries {/* comments */} — must NOT be skipped"
run_hook "$(write_payload package.json sess-10c)" DETENT_ROOT="$DETENT10"
[ -z "$OUT" ] || fail "*.json has no comment syntax — should stay skipped, got: $OUT"
run_hook "$(write_payload docs/plain.md sess-10e)" DETENT_ROOT="$DETENT10"
[ -z "$OUT" ] || fail "plain *.md is prose — should stay skipped, got: $OUT"
echo "ok 10 - *.html, *.yaml, *.mdx emit; *.json and *.md stay skipped"; pass=$((pass+1))

# --- 11. SessionStart emits, tagged as SessionStart --------------------------
DETENT11="$TMP/detent11"; mkdir -p "$DETENT11"
SS11="$(jq -cn '{session_id:"sess-11", hook_event_name:"SessionStart", source:"startup"}')"
run_hook "$SS11" DETENT_ROOT="$DETENT11"
[ "$HOOK_RC" -eq 0 ] || fail "SessionStart should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "SessionStart must emit — it is what covers the first write"
[ "$(jq -r '.hookSpecificOutput.hookEventName' <<<"$OUT")" = "SessionStart" ] \
  || fail "hookEventName should echo SessionStart, got: $OUT"
ctx11="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT")"
[[ "$ctx11" == *"$CANON"* ]] || fail "SessionStart context missing the canonical phrase: $ctx11"
echo "ok 11 - SessionStart emits the standard, tagged SessionStart"; pass=$((pass+1))

# --- 12. the two events share one dedup marker -------------------------------
run_hook "$(write_payload src/only-write.ts sess-11)" DETENT_ROOT="$DETENT11"
[ "$HOOK_RC" -eq 0 ] || fail "post-SessionStart write should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "a write after SessionStart in the SAME session must be deduped, got: $OUT"
echo "ok 12 - SessionStart and PostToolUse share one marker: exactly one injection"; pass=$((pass+1))

# --- 13. a subagent sharing the parent's session_id is NOT starved -----------
# Parent: SessionStart on transcript A. Subagent: Write on transcript B, SAME
# session_id (subagent payloads carry the parent's). B must still emit.
DETENT13="$TMP/detent13"; mkdir -p "$DETENT13"
PARENT13="$(jq -cn '{session_id:"sess-13", transcript_path:"/t/parent-13.jsonl",
                     hook_event_name:"SessionStart", source:"startup"}')"
run_hook "$PARENT13" DETENT_ROOT="$DETENT13"
[ -n "$OUT" ] || fail "parent SessionStart should emit, got nothing"
SUB13="$(jq -cn '{session_id:"sess-13", transcript_path:"/t/subagent-13.jsonl",
                  tool_name:"Write", tool_input:{file_path:"src/sub.ts", content:"x"}}')"
run_hook "$SUB13" DETENT_ROOT="$DETENT13"
[ "$HOOK_RC" -eq 0 ] || fail "subagent write should exit 0, got $HOOK_RC"
[ -n "$OUT" ] || fail "subagent sharing the parent's session_id MUST still get the rule — keyed on session_id alone the parent starves every subagent"
# ...and that same subagent is still deduped against itself.
run_hook "$SUB13" DETENT_ROOT="$DETENT13"
[ -z "$OUT" ] || fail "the same subagent should be deduped on its second write, got: $OUT"
echo "ok 13 - a subagent sharing the parent's session_id still gets the rule, once"; pass=$((pass+1))

echo "ok 1..$pass"
echo "test-comment-discipline: all $pass tests passed"
