#!/usr/bin/env bash
# Manual demo: exercises both hooks with fake payloads / a fake transcript
# and prints their raw output. Safe to run anywhere; writes only to mktemp.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo '--- exitplan-reminder: matching ExitPlanMode call ---'
echo '{"hook_event_name":"PostToolUse","tool_name":"ExitPlanMode","tool_input":{"plan":"1. do X"},"tool_response":{"success":true}}' | bash exitplan-reminder.sh

echo '--- exitplan-reminder: non-matching (Bash) call -> expect no output ---'
echo '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' | bash exitplan-reminder.sh
echo '(no output above = correct)'

echo '--- check-curator-used: fake transcript, artifact written, curator never opened ---'
FT="$(mktemp)"
printf '%s\n' \
 '{"type":"user","message":{"role":"user","content":"deep-research the caching options"}}' \
 '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"/repo/.plans/caching-research.html"}}]}}' \
 '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"w1","content":"ok"}]}}' > "$FT"
printf '{"session_id":"demo","transcript_path":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$FT" | bash check-curator-used.sh

echo '--- check-curator-used: same transcript + curator invoked -> expect no output ---'
printf '%s\n' \
 '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"curator /repo/.plans/caching-research.html"}}]}}' \
 '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b1","content":"opened"}]}}' >> "$FT"
printf '{"session_id":"demo","transcript_path":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$FT" | bash check-curator-used.sh
echo '(no output above = correct)'
rm -f "$FT"
