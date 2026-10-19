#!/usr/bin/env bash
# test-voice-discipline.sh — offline tests for hooks/voice-discipline.sh
# (no network, no git, no real writes outside a scratch DETENT_ROOT).
#
# Proves:
#   1. VOICE_DISCIPLINE=off kill switch: exits 0, prints nothing.
#   2. A prose file (*.md) emits hookSpecificOutput.additionalContext carrying
#      the standard, with suppressOutput true.
#   3. A code file emits nothing — comment-discipline.sh owns those, and the two
#      hooks must never both fire on one write.
#   4. A second prose Write in the SAME agent emits nothing (dedup marker).
#   5. A Write from a DIFFERENT agent emits again.
#   6. Empty / malformed stdin exits 0 in silence.
#   7. CLAUDE_JOB_DIR set STILL emits — the deliberate divergence from the
#      spawn-work hooks, matching comment-discipline.sh. This test exists so
#      nobody "fixes" the hook to self-disable.
#   8. OWL_RUN set STILL emits, same reason.
#   9. An Edit-shaped payload (new_string, no content) is handled like a Write.
#  10. The gate is an ALLOWLIST: *.mdx emits nothing (it embeds JSX, so the
#      sibling hook owns it), and so does an extensionless path. Pins the gate
#      against a well-meaning "any text file is prose" widening.
#  11. SessionStart emits with hookEventName "SessionStart" and no tool_input —
#      covering the session whose first and only Write is a finished document.
#  12. The two events share ONE dedup marker: after SessionStart, that agent's
#      first prose Write stays silent. Exactly one injection per agent.
#  13. A SUBAGENT — same session_id as the parent, different transcript_path —
#      still gets the rule after the parent's SessionStart consumed its marker.
#      Regression guard: keyed on session_id alone the parent would starve every
#      subagent, the population PostToolUse exists to reach.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../voice-discipline.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/voice-discipline-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# A phrase from the injected standard that must survive any rewording pass.
CANON="lead with the answer or the ask"

# write_payload <file_path> <session_id> [transcript]
write_payload() {
  jq -cn --arg fp "$1" --arg sid "$2" --arg tr "${3:-/t/$2.jsonl}" \
    '{session_id:$sid, transcript_path:$tr, tool_name:"Write",
      tool_input:{file_path:$fp, content:"x"}}'
}

# edit_payload <file_path> <session_id>
edit_payload() {
  jq -cn --arg fp "$1" --arg sid "$2" --arg tr "/t/$2.jsonl" \
    '{session_id:$sid, transcript_path:$tr, tool_name:"Edit",
      tool_input:{file_path:$fp, old_string:"a", new_string:"b"}}'
}

# session_payload <session_id> [transcript]
session_payload() {
  jq -cn --arg sid "$1" --arg tr "${2:-/t/$1.jsonl}" \
    '{hook_event_name:"SessionStart", session_id:$sid, transcript_path:$tr}'
}

# run_hook <payload> [ENV=val ...] — clears CLAUDE_JOB_DIR / OWL_RUN from the
# ambient environment first (this test may itself run inside a background job),
# then applies overrides, so a test can re-set one to exercise no-self-disable.
run_hook() {
  local input="$1"; shift
  set +e
  OUT="$(env -u CLAUDE_JOB_DIR -u OWL_RUN "$@" bash "$HOOK" <<<"$input")"
  HOOK_RC=$?
  set -e
}

# --- 1. VOICE_DISCIPLINE=off kill switch -------------------------------------
run_hook "$(write_payload "docs/a.md" s1)" DETENT_ROOT="$TMP/r1" VOICE_DISCIPLINE=off
[ "$HOOK_RC" -eq 0 ] || fail "1: kill switch should exit 0, got $HOOK_RC"
[ -z "$OUT" ] || fail "1: kill switch should print nothing, got: $OUT"
pass=$((pass+1))

# --- 2. prose file emits ------------------------------------------------------
run_hook "$(write_payload "docs/runbook.md" s2)" DETENT_ROOT="$TMP/r2"
[ "$HOOK_RC" -eq 0 ] || fail "2: expected exit 0, got $HOOK_RC"
grep -q "$CANON" <<<"$OUT" || fail "2: standard text missing from output"
[ "$(jq -r '.suppressOutput' <<<"$OUT")" = "true" ] || fail "2: suppressOutput not true"
[ "$(jq -r '.hookSpecificOutput.hookEventName' <<<"$OUT")" = "PostToolUse" ] \
  || fail "2: wrong hookEventName"
pass=$((pass+1))

# --- 3. code file is silent (sibling hook owns it) ----------------------------
for f in src/main.go app/x.ts lib/y.py conf.yaml page.html; do
  run_hook "$(write_payload "$f" "s3-$RANDOM")" DETENT_ROOT="$TMP/r3"
  [ -z "$OUT" ] || fail "3: $f should be silent (comment-discipline owns it), got: $OUT"
done
pass=$((pass+1))

# --- 4. dedup: same agent, second prose write --------------------------------
run_hook "$(write_payload "docs/first.md" s4)" DETENT_ROOT="$TMP/r4"
grep -q "$CANON" <<<"$OUT" || fail "4: first write should emit"
run_hook "$(write_payload "docs/second.md" s4)" DETENT_ROOT="$TMP/r4"
[ -z "$OUT" ] || fail "4: second write in same agent should be silent, got: $OUT"
pass=$((pass+1))

# --- 5. a different agent emits again ----------------------------------------
run_hook "$(write_payload "docs/third.md" s5)" DETENT_ROOT="$TMP/r4"
grep -q "$CANON" <<<"$OUT" || fail "5: a different agent should emit"
pass=$((pass+1))

# --- 6. empty / malformed stdin ----------------------------------------------
run_hook "" DETENT_ROOT="$TMP/r6"
[ "$HOOK_RC" -eq 0 ] || fail "6: empty stdin should exit 0"
[ -z "$OUT" ] || fail "6: empty stdin should print nothing"
run_hook "not json at all" DETENT_ROOT="$TMP/r6"
[ "$HOOK_RC" -eq 0 ] || fail "6: malformed stdin should exit 0"
[ -z "$OUT" ] || fail "6: malformed stdin should print nothing"
pass=$((pass+1))

# --- 7 & 8. no self-disable under job / owl ----------------------------------
run_hook "$(write_payload "docs/job.md" s7)" DETENT_ROOT="$TMP/r7" CLAUDE_JOB_DIR="$TMP/job"
grep -q "$CANON" <<<"$OUT" \
  || fail "7: must STILL emit under CLAUDE_JOB_DIR — deliberate, do not 'fix'"
run_hook "$(write_payload "docs/owl.md" s8)" DETENT_ROOT="$TMP/r8" OWL_RUN=1
grep -q "$CANON" <<<"$OUT" || fail "8: must STILL emit under OWL_RUN — deliberate"
pass=$((pass+2))

# --- 9. Edit-shaped payload --------------------------------------------------
run_hook "$(edit_payload "docs/edit.md" s9)" DETENT_ROOT="$TMP/r9"
grep -q "$CANON" <<<"$OUT" || fail "9: Edit payload should be handled like Write"
pass=$((pass+1))

# --- 10. gate is an allowlist ------------------------------------------------
for f in docs/x.mdx Makefile Dockerfile; do
  run_hook "$(write_payload "$f" "s10-$RANDOM")" DETENT_ROOT="$TMP/r10"
  [ -z "$OUT" ] || fail "10: $f should be silent (allowlist gate), got: $OUT"
done
for f in docs/a.md notes.markdown spec.rst plain.txt book.adoc; do
  run_hook "$(write_payload "$f" "s10b-$RANDOM")" DETENT_ROOT="$TMP/r10b"
  grep -q "$CANON" <<<"$OUT" || fail "10: $f should emit"
done
pass=$((pass+1))

# --- 11. SessionStart emits --------------------------------------------------
run_hook "$(session_payload s11)" DETENT_ROOT="$TMP/r11"
grep -q "$CANON" <<<"$OUT" || fail "11: SessionStart should emit"
[ "$(jq -r '.hookSpecificOutput.hookEventName' <<<"$OUT")" = "SessionStart" ] \
  || fail "11: wrong hookEventName for SessionStart"
pass=$((pass+1))

# --- 12. the two events share one marker ------------------------------------
run_hook "$(session_payload s12)" DETENT_ROOT="$TMP/r12"
grep -q "$CANON" <<<"$OUT" || fail "12: SessionStart should emit first"
run_hook "$(write_payload "docs/after.md" s12)" DETENT_ROOT="$TMP/r12"
[ -z "$OUT" ] || fail "12: prose write after SessionStart should be silent, got: $OUT"
pass=$((pass+1))

# --- 13. subagent still gets it (regression guard) --------------------------
# Same session_id as the parent, different transcript — must NOT be starved.
run_hook "$(session_payload s13 /t/parent.jsonl)" DETENT_ROOT="$TMP/r13"
grep -q "$CANON" <<<"$OUT" || fail "13: parent SessionStart should emit"
run_hook "$(write_payload "docs/sub.md" s13 /t/child.jsonl)" DETENT_ROOT="$TMP/r13"
grep -q "$CANON" <<<"$OUT" \
  || fail "13: subagent (same session_id, different transcript) must still emit"
pass=$((pass+1))

# --- 14. voice file is named only when voice.file is configured -------------
run_hook "$(write_payload "docs/nofile.md" s14a)" DETENT_ROOT="$TMP/r14a"
grep -q "$CANON" <<<"$OUT" || fail "14: standard must still emit without voice.file"
grep -q "voice.md\|scribe-profiles" <<<"$OUT" && fail "14: no voice.file configured, but output names a voice file: $OUT"
mkdir -p "$TMP/r14b"
printf 'voice:\n  file: .local/my-voice.md\n' >"$TMP/r14b/detent.user.yaml"
run_hook "$(write_payload "docs/withfile.md" s14b)" DETENT_ROOT="$TMP/r14b"
grep -q "$CANON" <<<"$OUT" || fail "14: standard must emit with voice.file"
grep -qF ".local/my-voice.md" <<<"$OUT" || fail "14: configured voice.file not named: $OUT"
mkdir -p "$TMP/r14c"
printf 'voice:\n  file: null\n' >"$TMP/r14c/detent.user.yaml"
run_hook "$(write_payload "docs/nullfile.md" s14c)" DETENT_ROOT="$TMP/r14c"
grep -q "my-voice\|voice.md\|null" <<<"$OUT" && fail "14: file: null must read as unset: $OUT"
mkdir -p "$TMP/r14d"
printf 'user:\n  name: ""\nvoice: {file: ".local/inline.md"}  # note\n' >"$TMP/r14d/detent.user.yaml"
run_hook "$(write_payload "docs/inline.md" s14d)" DETENT_ROOT="$TMP/r14d"
grep -qF ".local/inline.md" <<<"$OUT" || fail "14: inline-form voice.file not named: $OUT"
pass=$((pass+1))

echo "PASS: $pass groups"
