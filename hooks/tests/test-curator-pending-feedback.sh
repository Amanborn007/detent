#!/usr/bin/env bash
# test-curator-pending-feedback.sh — offline tests for the Stop hook
# hooks/curator-pending-feedback-check.sh (no network, no curator server).
#
# Proves:
#   1. no state file            -> allow (exit 0, no output)
#   2. open session, pending>0  -> BLOCK, reason names the file
#   3. ended session, pending>0 -> allow (ended sessions are not stranding)
#   4. open session, pending=0  -> allow
#   5. stop_hook_active=true     -> allow even with pending (loop guard)
#   6. corrupt state.json        -> allow (never block on a parse error)
#   7. multiple open sessions    -> BLOCK lists every stranded file
#   8. missing `sessions` key    -> allow
#   9. non-dict session value    -> allow
#  10. non-list `pending`        -> allow
#  11. ownership scoping         -> a session outside the owned dir does NOT
#                                   block, one inside it does (and is the only
#                                   one named)
#  12. already-delivered fingerprint (poll-failures.json) -> allow, no re-block
#  13. background job (CLAUDE_JOB_DIR set) -> allow unconditionally, even when
#      CLAUDE_PROJECT_DIR/PWD would otherwise scope onto a stranded session
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../curator-pending-feedback-check.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/curator-pending-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# run_hook <state-dir> <stdin-json> -> prints hook stdout; sets HOOK_RC
# CLAUDE_PROJECT_DIR is pinned to "/" so ownership scoping (MAJOR 1) is a
# no-op for these legacy fixtures, which use arbitrary paths like /x/p.html
# unrelated to the real test-runner cwd. Tests that exercise scoping itself
# use run_hook_env below instead.
run_hook() {
  local dir="$1" stdin="$2"
  set +e
  HOOK_OUT="$(printf '%s' "$stdin" | env CURATOR_STATE_DIR="$dir" CLAUDE_PROJECT_DIR=/ CLAUDE_JOB_DIR= bash "$HOOK" 2>/dev/null)"
  HOOK_RC=$?
  set -e
}

# run_hook_env <state-dir> <stdin-json> <extra-env-assignments...> -> like
# run_hook but lets a test fully control the ownership env vars instead of
# the CLAUDE_PROJECT_DIR=/ default.
run_hook_env() {
  local dir="$1" stdin="$2"; shift 2
  set +e
  HOOK_OUT="$(printf '%s' "$stdin" | env CURATOR_STATE_DIR="$dir" "$@" bash "$HOOK" 2>/dev/null)"
  HOOK_RC=$?
  set -e
}

mkstate() { # <dir> <json> ; writes <dir>/state.json
  mkdir -p "$1"; printf '%s' "$2" > "$1/state.json"
}

# --- 1. no state file -> allow -----------------------------------------------
D="$TMP/t1"; mkdir -p "$D"
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "1: expected exit 0 with no state file"
[ -z "$HOOK_OUT" ] || fail "1: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 2. open session with pending -> BLOCK -----------------------------------
D="$TMP/t2"
mkstate "$D" '{"sessions":{"/x/.plans/brief.html":{"file":"/x/.plans/brief.html","ended":false,"pending":[{"type":"decision","question":"item:a","answer":"act"}]}}}'
run_hook "$D" '{}'
echo "$HOOK_OUT" | grep -q '"decision": "block"' || fail "2: expected block, got: $HOOK_OUT"
echo "$HOOK_OUT" | grep -q '/x/.plans/brief.html' || fail "2: block reason must name the file"
pass=$((pass+1))

# --- 3. ended session with pending -> allow ----------------------------------
D="$TMP/t3"
mkstate "$D" '{"sessions":{"/x/p.html":{"file":"/x/p.html","ended":true,"pending":[{"type":"decision","question":"q","answer":"act"}]}}}'
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "3: expected exit 0 for ended session"
[ -z "$HOOK_OUT" ] || fail "3: ended session must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 4. open session, empty pending -> allow ---------------------------------
D="$TMP/t4"
mkstate "$D" '{"sessions":{"/x/p.html":{"file":"/x/p.html","ended":false,"pending":[]}}}'
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "4: expected exit 0 for empty pending"
[ -z "$HOOK_OUT" ] || fail "4: empty pending must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 5. stop_hook_active -> allow even with pending (loop guard) --------------
D="$TMP/t5"
mkstate "$D" '{"sessions":{"/x/p.html":{"file":"/x/p.html","ended":false,"pending":[{"type":"decision","question":"q","answer":"act"}]}}}'
run_hook "$D" '{"stop_hook_active":true}'
[ "$HOOK_RC" -eq 0 ] || fail "5: expected exit 0 when stop_hook_active"
[ -z "$HOOK_OUT" ] || fail "5: stop_hook_active must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 6. corrupt state.json -> allow ------------------------------------------
D="$TMP/t6"; mkdir -p "$D"; printf '%s' 'not json {{{' > "$D/state.json"
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "6: expected exit 0 on corrupt state"
[ -z "$HOOK_OUT" ] || fail "6: corrupt state must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 7. multiple open stranded sessions -> BLOCK lists both ------------------
D="$TMP/t7"
mkstate "$D" '{"sessions":{"/a.html":{"file":"/a.html","ended":false,"pending":[{"x":1}]},"/b.html":{"file":"/b.html","ended":false,"pending":[{"x":1},{"y":2}]}}}'
run_hook "$D" '{}'
echo "$HOOK_OUT" | grep -q '"decision": "block"' || fail "7: expected block"
echo "$HOOK_OUT" | grep -q '/a.html' || fail "7: must list /a.html"
echo "$HOOK_OUT" | grep -q '/b.html' || fail "7: must list /b.html"
pass=$((pass+1))

# --- 8. missing `sessions` key -> allow --------------------------------------
D="$TMP/t8"
mkstate "$D" '{}'
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "8: expected exit 0 with no sessions key"
[ -z "$HOOK_OUT" ] || fail "8: missing sessions key must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 9. non-dict session value -> allow --------------------------------------
D="$TMP/t9"
mkstate "$D" '{"sessions":{"/x/p.html":"not-a-dict"}}'
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "9: expected exit 0 for non-dict session value"
[ -z "$HOOK_OUT" ] || fail "9: non-dict session value must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 10. non-list `pending` -> allow -----------------------------------------
D="$TMP/t10"
mkstate "$D" '{"sessions":{"/x/p.html":{"file":"/x/p.html","ended":false,"pending":"oops-not-a-list"}}}'
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "10: expected exit 0 for non-list pending"
[ -z "$HOOK_OUT" ] || fail "10: non-list pending must not block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 11. ownership scoping: outside-owned-dir session must NOT block, -------
#         inside-owned-dir session is the only one named -------------------
D="$TMP/t11"
OWNED_DIR="$TMP/t11-owned"
OTHER_DIR="$TMP/t11-other"
mkdir -p "$OWNED_DIR" "$OTHER_DIR"
mkstate "$D" "$(printf '{"sessions":{"%s/in.html":{"file":"%s/in.html","ended":false,"pending":[{"x":1}]},"%s/out.html":{"file":"%s/out.html","ended":false,"pending":[{"x":1}]}}}' \
  "$OWNED_DIR" "$OWNED_DIR" "$OTHER_DIR" "$OTHER_DIR")"
run_hook_env "$D" '{}' CLAUDE_PROJECT_DIR="$OWNED_DIR" DETENT_ROOT= PWD=/nonexistent-scope CLAUDE_JOB_DIR=
echo "$HOOK_OUT" | grep -q '"decision": "block"' || fail "11: expected block for the owned session, got: $HOOK_OUT"
echo "$HOOK_OUT" | grep -q "$OWNED_DIR/in.html" || fail "11: must name the owned session $OWNED_DIR/in.html, got: $HOOK_OUT"
echo "$HOOK_OUT" | grep -q "$OTHER_DIR/out.html" && fail "11: must NOT name the out-of-scope session $OTHER_DIR/out.html, got: $HOOK_OUT"
pass=$((pass+1))

# --- 12. already-delivered fingerprint (poll-failures.json) -> allow --------
D="$TMP/t12"
SESSION_ID="abc123def456"
PENDING_JSON='[{"type":"comment","text":"hi"}]'
FP="$(SID="$SESSION_ID" PJ="$PENDING_JSON" python3 -c "
import os, hashlib
print(hashlib.sha256((os.environ['SID'] + os.environ['PJ']).encode('utf-8')).hexdigest())
")"
mkstate "$D" "$(printf '{"sessions":{"/x/p.html":{"file":"/x/p.html","id":"%s","ended":false,"pending":%s}}}' "$SESSION_ID" "$PENDING_JSON")"
printf '{"/x/p.html":{"count":1,"lastDeliveredFingerprint":"%s"}}' "$FP" > "$D/poll-failures.json"
run_hook "$D" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "12: expected exit 0 for already-delivered fingerprint"
[ -z "$HOOK_OUT" ] || fail "12: already-delivered fingerprint must not re-block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 12b. control: same session but a DIFFERENT recorded fingerprint -------
#          (e.g. new feedback arrived after the last delivery) still blocks
D="$TMP/t12b"
mkstate "$D" "$(printf '{"sessions":{"/x/p.html":{"file":"/x/p.html","id":"%s","ended":false,"pending":%s}}}' "$SESSION_ID" "$PENDING_JSON")"
printf '{"/x/p.html":{"count":1,"lastDeliveredFingerprint":"stale-fingerprint-does-not-match"}}' > "$D/poll-failures.json"
run_hook "$D" '{}'
echo "$HOOK_OUT" | grep -q '"decision": "block"' || fail "12b: a stale/mismatched fingerprint must still block, got: $HOOK_OUT"
pass=$((pass+1))

# --- 13. background job -> allow unconditionally, even if CLAUDE_PROJECT_DIR --
#         would otherwise scope onto the stranded session ------------------
D="$TMP/t13"
mkstate "$D" "$(printf '{"sessions":{"%s/in.html":{"file":"%s/in.html","ended":false,"pending":[{"x":1}]}}}' "$OWNED_DIR" "$OWNED_DIR")"
run_hook_env "$D" '{}' CLAUDE_PROJECT_DIR="$OWNED_DIR" DETENT_ROOT= PWD="$OWNED_DIR" CLAUDE_JOB_DIR=/some/job/dir
[ "$HOOK_RC" -eq 0 ] || fail "13: expected exit 0 for a background job"
[ -z "$HOOK_OUT" ] || fail "13: a background job must never block, got: $HOOK_OUT"
pass=$((pass+1))

echo "PASS: $pass/14 curator-pending-feedback stop-hook tests"
