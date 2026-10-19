#!/usr/bin/env bash
# test-sentinel-inbox-check.sh — offline tests for the Stop hook
# hooks/sentinel-inbox-check.sh (no network, no gh, no live scanner).
#
# The hook is the reader half of sentinel-autoscan: the scanner writes each
# round to <inbox>/respond-inbox.jsonl, and this hook is what keeps the session
# alive long enough to act on rounds that arrive after the fix push.
#
#
# Each case below states what it proves. 17-21 are regressions for the
# state-handling regressions found in review.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../sentinel-inbox-check.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/sentinel-inbox-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# run_hook <inbox-base> <stdin-json> [extra env assignments...]
run_hook() {
  local base="$1" stdin="$2"; shift 2
  # Most cases model a hook that has been installed for a while; case 36 sets
  # SEED_SINCE=0 to exercise the install cursor being written for the first time.
  [ "${SEED_SINCE:-1}" = "1" ] && [ -d "$base" ] && [ ! -f "$base/.inbox-reader-since" ] && \
    printf '2000-01-01T00:00:00Z\n' > "$base/.inbox-reader-since"
  set +e
  HOOK_OUT="$(printf '%s' "$stdin" | env DETENT_INBOX_DIR="$base" CLAUDE_JOB_DIR= \
    PR_AUTOREVIEW=on SENTINEL_AUTOSCAN=on "$@" bash "$HOOK" 2>/dev/null)"
  HOOK_RC=$?
  set -e
}

# SCAN_TS lets a case control the event timestamp, which is part of the ack fingerprint.
SCAN_TS="2026-09-01T10:00:00Z"

# mkscan <inbox-dir> <round> <sha> <new_findings> <escalations> <blocking_open> <converged>
# Appends one sentinel_scan line shaped like the scanner writes it.
mkscan() {
  local dir="$1" round="$2" sha="$3" nf="$4" esc="$5" blocking="$6" converged="$7"
  mkdir -p "$dir"
  local findings='[]' escs='[]'
  [ "$nf" -gt 0 ] && findings="$(jq -cn --argjson n "$nf" '[range($n) | {bot:"review-bot[bot]",severity:"P1",file:"src/a.ts",line:10,url:"https://x/c\(.)"}]')"
  [ "$esc" -gt 0 ] && escs="$(jq -cn --argjson n "$esc" '[range($n) | {bot:"human:msmith",severity:"n/a",reason:"human-thread:new",url:"https://x/t\(.)"}]')"
  jq -cn --arg pr "https://github.com/o/r/pull/7" --argjson round "$round" --arg sha "$sha" \
    --argjson f "$findings" --argjson e "$escs" --arg ts "$SCAN_TS" \
    --argjson b "$blocking" --argjson c "$converged" \
    '{ts:$ts, type:"sentinel_scan", pr:$pr, round:$round, head_sha:$sha,
      result:{new_findings:$f, human_escalations:$e, blocking_open:$b, converged:$c,
              blocking_detail:{threads_scanned:true}, next_step:"do the thing"}}' \
    >> "$dir/respond-inbox.jsonl"
}

# mkerr <inbox-dir> <round> <sha> — one sentinel_scan_error line, as the scanner writes it
mkerr() {
  local dir="$1" round="$2" sha="$3"
  mkdir -p "$dir"
  jq -cn --arg pr "https://github.com/o/r/pull/7" --argjson round "$round" --arg sha "$sha" \
    --arg ts "$SCAN_TS" \
    '{ts:$ts, type:"sentinel_scan_error", pr:$pr, round:$round,
      head_sha:$sha, error:"sentinel scan exited nonzero; see sentinel-autoscan.log"}' \
    >> "$dir/respond-inbox.jsonl"
}

# mknewcommit <inbox-dir> <old-sha> <new-sha> — the window-restart line the scanner writes
mknewcommit() {
  local dir="$1" old="$2" new="$3"
  mkdir -p "$dir"
  jq -cn --arg pr "https://github.com/o/r/pull/7" --arg old "$old" --arg new "$new" \
    '{ts:"2026-09-01T10:00:00Z", type:"new_commit", pr:$pr, window:2, old_sha:$old, new_sha:$new}' \
    >> "$dir/respond-inbox.jsonl"
}

# live_scanner <inbox-dir> — a real running process whose argv[0] looks like the scanner,
# so the hook's ownership check sees what it would see against the genuine article.
# live_scanner <inbox-dir> — a lock with a fresh heartbeat, as a running scanner keeps it
live_scanner() {
  mkdir -p "$1/.autoscan.lock"
  echo $$ > "$1/.autoscan.lock/pid"
  touch "$1/.autoscan.lock/heartbeat"
}
# dead_scanner <inbox-dir> — a lock whose heartbeat has aged out (crashed mid-window)
dead_scanner() {
  mkdir -p "$1/.autoscan.lock"
  echo $$ > "$1/.autoscan.lock/pid"
  touch -t 202501010000 "$1/.autoscan.lock/heartbeat"
}
# killed_scanner <inbox-dir> — heartbeat still fresh, but the process is gone
killed_scanner() {
  mkdir -p "$1/.autoscan.lock"
  echo 999999 > "$1/.autoscan.lock/pid"
  touch "$1/.autoscan.lock/heartbeat"
}
# reused_pid_scanner <inbox-dir> — a live PID, but no heartbeat: the lock is stale and
# the number now belongs to something else entirely.
reused_pid_scanner() {
  mkdir -p "$1/.autoscan.lock"
  echo $$ > "$1/.autoscan.lock/pid"
}

# --- 1. no inbox base dir -> allow -------------------------------------------
run_hook "$TMP/nope" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "1: expected exit 0 with no base dir"
[ -z "$HOOK_OUT" ] || fail "1: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 2. converged with nothing blocking -> allow ------------------------------
B="$TMP/t2"; D="$B/o__r__pr7"
mkscan "$D" 3 abc123 0 0 0 true
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "2: expected allow on a converged loop"
[ -z "$HOOK_OUT" ] || fail "2: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 3. actionable findings, unacked -> BLOCK ---------------------------------
B="$TMP/t3"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 3 1 2 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "3: expected block, got: $HOOK_OUT"
grep -q "pull/7" <<<"$HOOK_OUT" || fail "3: reason must name the PR url"
grep -q "round 2" <<<"$HOOK_OUT" || fail "3: reason must name the round"
pass=$((pass+1))

# --- 4. fingerprint already acked -> allow ------------------------------------
B="$TMP/t4"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 3 1 2 false
printf 'abc123:2:%s\n' "$SCAN_TS" > "$D/sentinel-acked"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "4: expected allow once the round is acked"
[ -z "$HOOK_OUT" ] || fail "4: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 5. stop_hook_active on state we never blocked on -> BLOCK -------------------
B="$TMP/t5"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 3 1 2 false
run_hook "$B" '{"stop_hook_active":true}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "5: unhandled findings must block even on a re-stop, got: $HOOK_OUT"
pass=$((pass+1))

# --- 6/7. master + watcher switches -> allow ----------------------------------
B="$TMP/t6"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 3 1 2 false
run_hook "$B" '{}' PR_AUTOREVIEW=off
[ "$HOOK_RC" -eq 0 ] && [ -z "$HOOK_OUT" ] || fail "6: PR_AUTOREVIEW=off must allow"
run_hook "$B" '{}' SENTINEL_AUTOSCAN=off
[ "$HOOK_RC" -eq 0 ] && [ -z "$HOOK_OUT" ] || fail "7: SENTINEL_AUTOSCAN=off must allow"
pass=$((pass+2))

# --- 8. background job -> allow ------------------------------------------------
B="$TMP/t8"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 3 1 2 false
run_hook "$B" '{}' CLAUDE_JOB_DIR=/some/job
[ "$HOOK_RC" -eq 0 ] || fail "8: expected allow in a background job"
[ -z "$HOOK_OUT" ] || fail "8: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 9. unparseable last line -> allow -----------------------------------------
B="$TMP/t9"; D="$B/o__r__pr7"
mkdir -p "$D"; printf 'not json at all\n' > "$D/respond-inbox.jsonl"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "9: expected allow on unparseable input"
[ -z "$HOOK_OUT" ] || fail "9: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 10. no news + scanner alive -> BLOCK to wait, bumps the counter -----------
B="$TMP/t10"; D="$B/o__r__pr7"
mkscan "$D" 4 abc123 0 0 1 false
live_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "10: expected block to wait, got: $HOOK_OUT"
grep -qi "still polling" <<<"$HOOK_OUT" || fail "10: reason must say the scanner is still polling"
[ -f "$D/sentinel-waits" ] || fail "10: expected a wait counter file"
[ "$(wc -l < "$D/sentinel-waits" | tr -d ' ')" = "1" ] || fail "10: expected exactly one recorded wait"
pass=$((pass+1))

# --- 11. blocking still open once the scanner has exited -> BLOCK ----------------
# The scanner giving up at its round cap is exactly when the loop stops short,
# so a still-open blocking finding has to hold the stop rather than pass.
B="$TMP/t11"; D="$B/o__r__pr7"
mkscan "$D" 8 abc123 0 0 1 false
dead_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "11: expected block on a blocking finding after the scanner exits, got: $HOOK_OUT"
grep -q "blocking" <<<"$HOOK_OUT" || fail "11: reason must name the blocking findings"
pass=$((pass+1))

# --- 12. wait counter at cap for THIS commit -> allow ----------------------------
B="$TMP/t12"; D="$B/o__r__pr7"
mkscan "$D" 4 abc123 0 0 0 false
live_scanner "$D"
for i in 1 2 3; do printf 'ts\tpr\tnosession|abc123:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=3
[ "$HOOK_RC" -eq 0 ] || fail "12: expected allow once this commit's wait cap is reached"
[ -z "$HOOK_OUT" ] || fail "12: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 13. blocking open with converged false -> BLOCK ------------------------------
# sentinel computes converged as (actionable 0 AND botsClean AND blocking_open 0),
# so converged never coexists with an open blocking finding; this is the real state.
B="$TMP/t13"; D="$B/o__r__pr7"
mkscan "$D" 5 abc123 0 0 2 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "13: expected block on open blocking findings, got: $HOOK_OUT"
grep -q "blocking" <<<"$HOOK_OUT" || fail "13: reason must name the blocking findings"
pass=$((pass+1))

# --- 14. two pending PR inboxes -> BLOCK names both -------------------------------
B="$TMP/t14"
mkscan "$B/o__r__pr7" 2 abc123 1 0 1 false
mkdir -p "$B/o__r__pr9"
jq -cn '{ts:"2026-09-01T10:00:00Z", type:"sentinel_scan", pr:"https://github.com/o/r/pull/9",
  round:1, head_sha:"def456",
  result:{new_findings:[{bot:"claude-review",severity:"high",file:"b.go",line:2,url:"https://x/z"}],
          human_escalations:[], blocking_open:1, converged:false,
          blocking_detail:{threads_scanned:true}, next_step:"fix it"}}' \
  > "$B/o__r__pr9/respond-inbox.jsonl"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "14: expected block, got: $HOOK_OUT"
grep -q "pull/7" <<<"$HOOK_OUT" || fail "14: must name pr7"
grep -q "pull/9" <<<"$HOOK_OUT" || fail "14: must name pr9"
pass=$((pass+1))

# --- 15. stale inbox (older than a day) -> allow -----------------------------------
B="$TMP/t15"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 3 1 2 false
touch -t 202501010000 "$D/respond-inbox.jsonl"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "15: expected allow on a stale inbox"
[ -z "$HOOK_OUT" ] || fail "15: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 16. ack is per round: a newer round blocks again --------------------------------
B="$TMP/t16"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 1 0 1 false
printf 'abc123:2:%s\n' "$SCAN_TS" > "$D/sentinel-acked"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "16: acked round must allow first"
mkscan "$D" 3 abc123 2 0 2 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "16: a new round must block again, got: $HOOK_OUT"
grep -q "round 3" <<<"$HOOK_OUT" || fail "16: reason must name the new round"
pass=$((pass+1))

# --- 17. converged=true carrying a human escalation -> BLOCK -----------------------
# sentinel's converged bit is bot-only: an open human thread never holds it. Taking
# converged as "done" therefore drops the escalation the human must see.
B="$TMP/t17"; D="$B/o__r__pr7"
mkscan "$D" 3 abc123 0 1 0 true
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "17: a human escalation must block even when converged, got: $HOOK_OUT"
grep -q "round 3" <<<"$HOOK_OUT" || fail "17: reason must name the round"
pass=$((pass+1))

# --- 18. an actionable round followed by a quiet one -> BLOCK on the EARLIER one ----
# new_findings is a delta, so sentinel reports a finding once and the next round
# reads 0. Only ever inspecting the last line discards the round that had the news.
B="$TMP/t18"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 2 0 0 false
mkscan "$D" 3 abc123 0 0 0 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "18: expected block on the earlier actionable round, got: $HOOK_OUT"
grep -q "round 2" <<<"$HOOK_OUT" || fail "18: reason must name round 2, the round that carried the findings"
pass=$((pass+1))

# --- 19. the wait cap is scoped per head SHA ----------------------------------------
# A new commit is a new polling window; an earlier commit burning its budget must
# not starve every push that follows.
B="$TMP/t19"; D="$B/o__r__pr7"
mkscan "$D" 1 newsha 0 0 0 false
live_scanner "$D"
for i in 1 2 3; do printf 'ts\tpr\tnosession|oldsha:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=3
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "19: a new commit must get a fresh wait budget, got: $HOOK_OUT"
grep -qi "still polling" <<<"$HOOK_OUT" || fail "19: expected the waiting reason"
pass=$((pass+1))

# --- 20. blocking open but the latest round is acked -> allow -------------------------
B="$TMP/t20"; D="$B/o__r__pr7"
mkscan "$D" 6 abc123 0 0 2 false
dead_scanner "$D"
printf 'abc123:6:%s\n' "$SCAN_TS" > "$D/sentinel-acked"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "20: an acked round must stop nagging even with blocking open"
[ -z "$HOOK_OUT" ] || fail "20: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 21. several unacked actionable rounds -> BLOCK lists every one ---------------------
B="$TMP/t21"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 1 0 0 false
mkscan "$D" 2 abc123 2 0 0 false
mkscan "$D" 3 abc123 0 0 0 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "21: expected block, got: $HOOK_OUT"
grep -q "round 1" <<<"$HOOK_OUT" || fail "21: must list round 1"
grep -q "round 2" <<<"$HOOK_OUT" || fail "21: must list round 2"
pass=$((pass+1))

# --- 22. a watched PR with no inbox file yet -> BLOCK to wait -------------------------
# The scanner mkdirs its inbox and takes the lock, then sleeps ~330s before the first
# scan. Keying discovery on respond-inbox.jsonl alone misses that whole window.
B="$TMP/t22"; D="$B/o__r__pr7"
mkdir -p "$D"
live_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "22: a live scanner with no rounds yet must block, got: $HOOK_OUT"
grep -qi "still polling\|not scanned yet\|no rounds" <<<"$HOOK_OUT" || fail "22: expected a waiting-shaped reason, got: $HOOK_OUT"
pass=$((pass+1))

# --- 23. same, but the scanner has exited -> allow --------------------------------------
B="$TMP/t23"; D="$B/o__r__pr7"
mkdir -p "$D"
dead_scanner "$D"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "23: a dead scanner with no rounds has nothing to wait for"
[ -z "$HOOK_OUT" ] || fail "23: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 24. every scan attempt errored, scanner alive -> BLOCK ------------------------------
# sentinel_scan_error lines were dropped entirely, so an all-failing window read as
# "nothing here" and let the session end.
B="$TMP/t24"; D="$B/o__r__pr7"
mkerr "$D" 1 abc123
mkerr "$D" 2 abc123
live_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "24: scan errors must not read as an empty inbox, got: $HOOK_OUT"
pass=$((pass+1))

# --- 25. an unacked scan error with the scanner gone -> BLOCK naming it -------------------
B="$TMP/t25"; D="$B/o__r__pr7"
mkerr "$D" 3 abc123
dead_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "25: expected block on an unacked scan error, got: $HOOK_OUT"
grep -qi "error" <<<"$HOOK_OUT" || fail "25: reason must name the scan error"
grep -q "round 3" <<<"$HOOK_OUT" || fail "25: reason must name the failed round"
pass=$((pass+1))

# --- 26. an acked scan error -> allow ------------------------------------------------------
B="$TMP/t26"; D="$B/o__r__pr7"
mkerr "$D" 3 abc123
dead_scanner "$D"
printf 'abc123:3:%s\n' "$SCAN_TS" > "$D/sentinel-acked"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "26: an acked scan error must stop nagging"
[ -z "$HOOK_OUT" ] || fail "26: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 27. a clean round then an error -> the error still surfaces ----------------------------
# Reasoning from the last clean scan while the newest event is a failure is stale state.
B="$TMP/t27"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 0 0 0 true
mkerr  "$D" 2 abc123
dead_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "27: a trailing error must not be masked by an earlier clean round, got: $HOOK_OUT"
grep -qi "error" <<<"$HOOK_OUT" || fail "27: reason must name the scan error"
pass=$((pass+1))

# --- 28. a new_commit event switches the active SHA -------------------------------------
# The scanner logs the commit switch and then sleeps before its first scan, so the last
# sentinel_scan still names the old commit; its spent budget must not starve the new one.
B="$TMP/t28"; D="$B/o__r__pr7"
mkscan "$D" 8 oldsha 0 0 0 false
mknewcommit "$D" oldsha freshsha
live_scanner "$D"
for i in 1 2 3; do printf 'ts\tpr\tnosession|oldsha:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=3
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "28: the new commit must get its own wait budget, got: $HOOK_OUT"
grep -q "freshsha" <<<"$HOOK_OUT" || fail "28: reason must name the new head SHA, got: $HOOK_OUT"
pass=$((pass+1))

# --- 29. an unchanged re-stop holds for a bounded number of tries ---------------------------
# Releasing on the first re-stop loses findings the agent simply ignored; never releasing
# spins forever. It holds for MAX_REBLOCKS, then lets go.
B="$TMP/t29"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 1 0 0 false
run_hook "$B" '{}' SENTINEL_STOP_MAX_REBLOCKS=2
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "29: expected the first stop to block"
run_hook "$B" '{"stop_hook_active":true}' SENTINEL_STOP_MAX_REBLOCKS=2
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "29: unacked findings must survive the first re-stop, got: $HOOK_OUT"
run_hook "$B" '{"stop_hook_active":true}' SENTINEL_STOP_MAX_REBLOCKS=2
[ "$HOOK_RC" -eq 0 ] || fail "29: the re-block budget must run out, or the hook spins"
[ -z "$HOOK_OUT" ] || fail "29: expected no output once the budget is spent, got: $HOOK_OUT"
pass=$((pass+1))

# --- 30. a re-stop after a NEW round arrived -> BLOCK again --------------------------------
# This is what lets the hook hold the session across several wait/rescan rounds.
B="$TMP/t30"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 1 0 0 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "30: expected the first stop to block"
mkscan "$D" 3 abc123 2 0 0 false
run_hook "$B" '{"stop_hook_active":true}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "30: a newly arrived round must block again, got: $HOOK_OUT"
grep -q "round 3" <<<"$HOOK_OUT" || fail "30: reason must name the new round"
pass=$((pass+1))

# --- 31. a reused PID is not a live scanner ------------------------------------------------
# The lock outlives a crashed scanner, and the OS recycles PIDs; kill -0 alone would
# block and burn wait budget on a process that has nothing to do with this PR.
B="$TMP/t31"; D="$B/o__r__pr7"
mkscan "$D" 4 abc123 0 0 0 false
reused_pid_scanner "$D"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "31: a recycled PID must not read as a live scanner, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "31: expected no output, got: $HOOK_OUT"
[ ! -f "$D/sentinel-waits" ] || fail "31: must not record a wait against a non-scanner PID"
pass=$((pass+1))

# --- 32. a later scanner reusing round 1 on the same SHA -> BLOCK ---------------------------
# round restarts at 1 for every scanner process while sentinel-acked persists, so a
# fingerprint of sha:round alone would silently discard the new finding.
B="$TMP/t32"; D="$B/o__r__pr7"
SCAN_TS="2026-09-01T10:00:00Z"
mkscan "$D" 1 abc123 1 0 0 false
run_hook "$B" '{}'
ACK_FP="$(jq -r '.reason' <<<"$HOOK_OUT" | sed -n 's/.*\[ack: \([^]]*\)\].*/\1/p' | head -1)"
[ -n "$ACK_FP" ] || fail "32: the reason must publish the exact ack fingerprint"
printf '%s\n' "$ACK_FP" > "$D/sentinel-acked"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "32: the acked round must go quiet, got: $HOOK_OUT"
SCAN_TS="2026-09-01T11:30:00Z"
mkscan "$D" 1 abc123 1 0 0 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "32: a new scanner's round 1 on the same SHA must not inherit the old ack, got: $HOOK_OUT"
SCAN_TS="2026-09-01T10:00:00Z"
pass=$((pass+1))

# --- 33. the heartbeat window follows DELAY/DEBOUNCE -----------------------------------------
# Both are configurable; a fixed timeout would call a healthy scanner dead mid-sleep.
B="$TMP/t33"; D="$B/o__r__pr7"
mkscan "$D" 4 abc123 0 0 0 false
mkdir -p "$D/.autoscan.lock"
echo $$ > "$D/.autoscan.lock/pid"
touch "$D/.autoscan.lock/heartbeat"
python3 -c "import os,sys,time; t=time.time()-900; os.utime(sys.argv[1],(t,t))" "$D/.autoscan.lock/heartbeat"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "33: a 15-minute-old heartbeat is dead at the default cadence"
run_hook "$B" '{}' SENTINEL_AUTOSCAN_DEBOUNCE=1200
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "33: a 20-minute debounce must widen the heartbeat window, got: $HOOK_OUT"
pass=$((pass+1))

# --- 34. new_commit followed by an acked error keeps the NEW sha active ----------------------
# latest_event is no longer the new_commit line, so deriving state from the last successful
# scan would silently fall back to the previous commit and its spent budget.
B="$TMP/t34"; D="$B/o__r__pr7"
mkscan "$D" 8 oldsha 0 0 0 false
mknewcommit "$D" oldsha freshsha
mkerr "$D" 1 freshsha
printf 'freshsha:1:%s\n' "$SCAN_TS" > "$D/sentinel-acked"
live_scanner "$D"
for i in 1 2 3; do printf 'ts\tpr\tnosession|oldsha:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=3
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "34: the new commit must stay active after an acked error, got: $HOOK_OUT"
grep -q "freshsha" <<<"$HOOK_OUT" || fail "34: reason must name the new head SHA, got: $HOOK_OUT"
pass=$((pass+1))

# --- 35. a malformed line must not hide the rounds after it -----------------------------------
B="$TMP/t35"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 0 0 0 false
printf 'not json at all\n' >> "$D/respond-inbox.jsonl"
mkscan "$D" 2 abc123 2 0 0 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "35: a garbage line must not swallow later rounds, got: $HOOK_OUT"
grep -q "round 2" <<<"$HOOK_OUT" || fail "35: the round after the garbage line must surface"
pass=$((pass+1))

# --- 36. installing the hook does not resurrect pre-existing rounds ---------------------------
# Inboxes that predate this hook have no sentinel-acked, so without a cursor the first
# run would re-raise findings that were handled long ago and drive duplicate pushes.
B="$TMP/t36"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 3 0 0 false
mkscan "$D" 2 abc123 2 0 0 false
SEED_SINCE=0 run_hook "$B" '{}'
# Retiring them silently would lose genuinely unclaimed rounds, so they are named once.
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "36: pre-install rounds must be announced once, got: $HOOK_OUT"
grep -qi "retired\|predate" <<<"$HOOK_OUT" || fail "36: the announcement must say they were retired at install"
[ -f "$B/.inbox-reader-since" ] || fail "36: expected an install cursor to be written"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "36: the announcement must not repeat, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "36: expected silence after the one-time announcement, got: $HOOK_OUT"
SCAN_TS="2099-01-01T00:00:00Z"
mkscan "$D" 3 abc123 1 0 0 false
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "36: a round after the cursor must still block, got: $HOOK_OUT"
grep -q "round 3" <<<"$HOOK_OUT" || fail "36: only the post-cursor round should surface"
grep -q "round 1" <<<"$HOOK_OUT" && fail "36: pre-cursor rounds must stay retired"
SCAN_TS="2026-09-01T10:00:00Z"
pass=$((pass+1))

# --- 37. a cwd in another repo scopes that repo's inboxes out ----------------------------------
# Same-repo pickup across sessions is the durability this hook exists for and stays;
# an unrelated repo's findings have no business holding this stop.
B="$TMP/t37"
mkdir -p "$B"
printf '2000-01-01T00:00:00Z\n' > "$B/.inbox-reader-since"
mkscan "$B/o__r__pr7" 1 abc123 2 0 0 false
OTHER="$TMP/otherrepo"
mkdir -p "$OTHER"
git -C "$OTHER" init -q 2>/dev/null
git -C "$OTHER" remote add origin https://github.com/someone/elsewhere.git 2>/dev/null
run_hook "$B" "$(jq -cn --arg c "$OTHER" '{cwd:$c}')"
[ "$HOOK_RC" -eq 0 ] || fail "37: another repo's inbox must not hold this stop, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "37: expected no output, got: $HOOK_OUT"
git -C "$OTHER" remote set-url origin https://github.com/o/r.git 2>/dev/null
run_hook "$B" "$(jq -cn --arg c "$OTHER" '{cwd:$c}')"
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "37: this repo's inbox must still hold, got: $HOOK_OUT"
pass=$((pass+1))

# --- 38. the install cursor never retires a live scanner's rounds -------------------------------
# The cursor is stamped on the first Stop, which can happen after that session's rounds
# have already landed; anchoring on "now" would baseline away the very work this exists for.
B="$TMP/t38"; D="$B/o__r__pr7"
mkdir -p "$D"
live_scanner "$D"
SCAN_TS="2099-01-01T00:00:00Z"
mkscan "$D" 1 abc123 2 0 0 false
SEED_SINCE=0 run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "38: a live scanner's rounds must survive cursor creation, got: $HOOK_OUT"
grep -q "round 1" <<<"$HOOK_OUT" || fail "38: the live scanner's round must surface"
SCAN_TS="2026-09-01T10:00:00Z"
pass=$((pass+1))

# --- 39. an unchanged WAITING re-stop keeps holding --------------------------------------------
# The advised sleep (DEBOUNCE) is shorter than the scanner's first delay, so the next stop
# legitimately sees the same wait fingerprint; allowing it ends the session before round 1.
B="$TMP/t39"; D="$B/o__r__pr7"
mkdir -p "$D"
live_scanner "$D"
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "39: expected the first stop to block"
run_hook "$B" '{"stop_hook_active":true}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "39: an unchanged waiting re-stop must keep holding, got: $HOOK_OUT"
pass=$((pass+1))

# --- 40. waiting stops holding once the scanner has burned the round budget ----------------------
# The budget is measured in scanner rounds, so it is quiet rounds that spend it.
B="$TMP/t40"; D="$B/o__r__pr7"
mkdir -p "$D"
live_scanner "$D"
run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=2
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "40: expected the pre-scan wait to block"
mkscan "$D" 1 abc123 0 0 0 false
run_hook "$B" '{"stop_hook_active":true}' SENTINEL_STOP_MAX_WAITS=2
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "40: expected the first quiet round to block"
mkscan "$D" 2 abc123 0 0 0 false
run_hook "$B" '{"stop_hook_active":true}' SENTINEL_STOP_MAX_WAITS=2
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "40: expected the second quiet round to block"
mkscan "$D" 3 abc123 0 0 0 false
run_hook "$B" '{"stop_hook_active":true}' SENTINEL_STOP_MAX_WAITS=2
[ "$HOOK_RC" -eq 0 ] || fail "40: waiting must stop holding once the round budget is spent, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "40: expected no output at the cap, got: $HOOK_OUT"
pass=$((pass+1))

# --- 41. a stale lock must not rewind the install cursor ----------------------------------------
# A crashed scanner leaves its lock behind; treating that as running would drag the cursor
# back and resurrect rounds handled long ago.
B="$TMP/t41"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 3 0 0 false
dead_scanner "$D"
SEED_SINCE=0 run_hook "$B" '{}'
# Retired-and-announced, not replayed as live work.
grep -qi "predate" <<<"$HOOK_OUT" || fail "41: the round should be retired at install, got: $HOOK_OUT"
grep -q "actionable" <<<"$HOOK_OUT" && fail "41: a stale lock must not rewind the cursor and replay the round as news"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "41: the retirement notice must not repeat, got: $HOOK_OUT"
pass=$((pass+1))

# --- 42. a fresh heartbeat from a dead process is not a live scanner ----------------------------
# A killed scanner leaves its last heartbeat behind; trusting it alone would hold the
# session and spend the wait budget when no further round can ever arrive.
B="$TMP/t42"; D="$B/o__r__pr7"
mkscan "$D" 4 abc123 0 0 0 false
killed_scanner "$D"
run_hook "$B" '{}'
[ "$HOOK_RC" -eq 0 ] || fail "42: a dead pid must not read as a live scanner, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "42: expected no output, got: $HOOK_OUT"
[ ! -f "$D/sentinel-waits" ] || fail "42: must not spend wait budget on a dead scanner"
pass=$((pass+1))

# --- 43. one session's suppression does not silence another's stop ------------------------------
# stop_hook_active only says some hook blocked; it does not say THIS session saw the round.
B="$TMP/t43"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 1 0 0 false
run_hook "$B" '{"session_id":"sess-A"}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "43: expected session A to block"
run_hook "$B" '{"session_id":"sess-A","stop_hook_active":true}'
[ "$HOOK_RC" -eq 0 ] || fail "43: session A's own unchanged re-stop must allow"
run_hook "$B" '{"session_id":"sess-B","stop_hook_active":true}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "43: session B must not inherit session A's suppression, got: $HOOK_OUT"
pass=$((pass+1))

# --- 44. an origin with a trailing slash still scopes to this repo -------------------------------
B="$TMP/t44"
mkdir -p "$B"
printf '2000-01-01T00:00:00Z\n' > "$B/.inbox-reader-since"
mkscan "$B/o__r__pr7" 1 abc123 2 0 0 false
SLASHREPO="$TMP/slashrepo"
mkdir -p "$SLASHREPO"
git -C "$SLASHREPO" init -q 2>/dev/null
git -C "$SLASHREPO" remote add origin https://github.com/o/r/ 2>/dev/null
run_hook "$B" "$(jq -cn --arg c "$SLASHREPO" '{cwd:$c}')"
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "44: a trailing slash must not exclude this repo, got: $HOOK_OUT"
pass=$((pass+1))

# --- 45. two sessions keep independent suppression ----------------------------------------------
# One shared record lets alternating sessions clobber each other into an endless re-stop cycle.
B="$TMP/t45"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 1 0 0 false
run_hook "$B" '{"session_id":"sess-A"}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "45: expected session A to block"
run_hook "$B" '{"session_id":"sess-B"}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "45: expected session B to block"
run_hook "$B" '{"session_id":"sess-A","stop_hook_active":true}'
[ "$HOOK_RC" -eq 0 ] || fail "45: session B must not have clobbered session A's suppression, got: $HOOK_OUT"
run_hook "$B" '{"session_id":"sess-B","stop_hook_active":true}'
[ "$HOOK_RC" -eq 0 ] || fail "45: session B's own re-stop must allow too, got: $HOOK_OUT"
pass=$((pass+1))

# --- 46. the cursor ignores a fresh heartbeat from a dead process --------------------------------
B="$TMP/t46"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 3 0 0 false
killed_scanner "$D"
SEED_SINCE=0 run_hook "$B" '{}'
grep -q "actionable" <<<"$HOOK_OUT" && fail "46: a killed scanner must not rewind the cursor and replay rounds as news"
pass=$((pass+1))

# --- 47. the default wait budget outlasts the scanner's polling run -----------------------------
# The scanner does one delay plus MAX_ROUNDS rounds for a commit; a smaller wait budget
# releases the session before the later rounds land.
B="$TMP/t47"; D="$B/o__r__pr7"
mkscan "$D" 8 abc123 0 0 0 false
live_scanner "$D"
for i in 1 2 3 4 5 6 7 8; do printf 'ts\tpr\tnosession|abc123:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{}'
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "47: the default budget must cover all 8 scanner rounds, got: $HOOK_OUT"
pass=$((pass+1))

# --- 48. a smaller scanner round budget shrinks the wait budget with it --------------------------
B="$TMP/t48"; D="$B/o__r__pr7"
mkscan "$D" 2 abc123 0 0 0 false
live_scanner "$D"
for i in 1 2 3 4; do printf 'ts\tpr\tnosession|abc123:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{}' SENTINEL_AUTOSCAN_MAX_ROUNDS=2
[ "$HOOK_RC" -eq 0 ] || fail "48: a 2-round scanner must not get a 10-wait budget, got: $HOOK_OUT"
pass=$((pass+1))

# --- 49. each session gets its own wait budget ---------------------------------------------------
# A shared budget lets concurrent sessions burn it in a fraction of the polling run.
B="$TMP/t49"; D="$B/o__r__pr7"
mkscan "$D" 1 abc123 0 0 0 false
live_scanner "$D"
for i in 1 2 3; do printf 'ts\tpr\tsess-A|abc123:%s\n' "$i" >> "$D/sentinel-waits"; done
run_hook "$B" '{"session_id":"sess-A"}' SENTINEL_STOP_MAX_WAITS=3
[ "$HOOK_RC" -eq 0 ] || fail "49: session A is at its cap and must be released, got: $HOOK_OUT"
run_hook "$B" '{"session_id":"sess-B"}' SENTINEL_STOP_MAX_WAITS=3
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "49: session B must have its own budget, got: $HOOK_OUT"
pass=$((pass+1))

# --- 50. a cwd that resolves to no GitHub repo scans nothing -------------------------------------
# Falling back to "scan everything" would block a non-GitHub checkout on another repo's PR.
B="$TMP/t50"
mkdir -p "$B"
printf '2000-01-01T00:00:00Z\n' > "$B/.inbox-reader-since"
mkscan "$B/o__r__pr7" 1 abc123 2 0 0 false
NOREMOTE="$TMP/noremote"
mkdir -p "$NOREMOTE"
git -C "$NOREMOTE" init -q 2>/dev/null
run_hook "$B" "$(jq -cn --arg c "$NOREMOTE" '{cwd:$c}')"
[ "$HOOK_RC" -eq 0 ] || fail "50: an unresolvable cwd must scan nothing, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "50: expected no output, got: $HOOK_OUT"
pass=$((pass+1))

# --- 51. repo scoping matches <slug>__pr<digits> exactly -----------------------------------------
# A bare prefix also catches a repo whose own name continues with __pr, whose findings
# would then drive changes to the wrong PR.
B="$TMP/t51"
mkdir -p "$B"
printf '2000-01-01T00:00:00Z\n' > "$B/.inbox-reader-since"
mkscan "$B/o__r__prX__pr7" 1 abc123 2 0 0 false
EXACTREPO="$TMP/exactrepo"
mkdir -p "$EXACTREPO"
git -C "$EXACTREPO" init -q 2>/dev/null
git -C "$EXACTREPO" remote add origin https://github.com/o/r.git 2>/dev/null
run_hook "$B" "$(jq -cn --arg c "$EXACTREPO" '{cwd:$c}')"
[ "$HOOK_RC" -eq 0 ] || fail "51: o/r must not claim the o/r__prX inbox, got: $HOOK_OUT"
[ -z "$HOOK_OUT" ] || fail "51: expected no output, got: $HOOK_OUT"
mkscan "$B/o__r__pr9" 1 abc123 1 0 0 false
run_hook "$B" "$(jq -cn --arg c "$EXACTREPO" '{cwd:$c}')"
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "51: its own inbox must still match, got: $HOOK_OUT"
# Exactly one inbox reported: the o__r__prX__pr7 one is still excluded.
[ "$(jq -r '.reason' <<<"$HOOK_OUT" | grep -c 'actionable')" -eq 1 ] || fail "51: the other repo's inbox must stay excluded, got: $HOOK_OUT"
pass=$((pass+1))

# --- 52. rapid stops in one interval cannot burn the wait budget ---------------------------------
# The budget tracks scanner rounds, not Stop invocations: otherwise a few quick stops
# exhaust it before the scanner's initial delay has even elapsed.
B="$TMP/t52"; D="$B/o__r__pr7"
mkdir -p "$D"
live_scanner "$D"
for _ in 1 2 3 4 5 6; do run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=3; done
[ "$(jq -r '.decision' <<<"$HOOK_OUT")" = "block" ] || fail "52: six stops in one interval must not exhaust a 3-round budget, got: $HOOK_OUT"
pass=$((pass+1))

# --- 53. the invocation ceiling still releases a wedged scanner ----------------------------------
B="$TMP/t53"; D="$B/o__r__pr7"
mkdir -p "$D"
live_scanner "$D"
for _ in 1 2 3 4 5 6; do run_hook "$B" '{}' SENTINEL_STOP_MAX_WAITS=3 SENTINEL_STOP_MAX_WAIT_STOPS=4; done
[ "$HOOK_RC" -eq 0 ] || fail "53: the invocation ceiling must eventually release, got: $HOOK_OUT"
pass=$((pass+1))

echo "PASS: $pass sentinel-inbox-check assertions"
