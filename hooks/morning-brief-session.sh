#!/usr/bin/env bash
# hooks/morning-brief-session.sh — SessionStart hook: first-session-of-day trigger
# for the morning brief.
#
# WHY THIS SHAPE: the full morning brief
# (Jira/Gmail/Slack) can ONLY be produced in an interactive session — those are
# interactive-only claude.ai connectors a headless cron cannot reach, and a cron
# cannot open a browser when you are away. So "scheduled every morning" is a
# TRIGGER, not a headless data-prep job: at the first interactive session of a
# new day, this hook nudges the agent to offer/run `detent herald`. It NEVER
# assembles data, calls a connector, or opens a browser — it only injects a
# one-line context nudge and exits.
#
# Mechanism: SessionStart hooks may inject context via
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
# The agent sees the nudge and offers the brief; the human decides.
#
# "Due" = never run before, OR the last brief ran on an earlier calendar day
# (local time). A weekend/leave gap therefore just means the next weekday
# session is due — the window widens automatically inside herald.mjs.
#
# Environment:
#   MORNING_HERALD_SESSION=off   disable the nudge entirely
#   DETENT_ROOT                detent clone root (else resolved from this script)

set -u

[ "${MORNING_HERALD_SESSION:-on}" = "off" ] && exit 0

SCRIPT_PATH="${BASH_SOURCE[0]}"
DETENT_ROOT="${DETENT_ROOT:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
STATE="$DETENT_ROOT/.local/brief-state.json"

# Only nudge when a session is actually beginning (startup/resume/clear), not on
# compaction — otherwise a long session re-nudges mid-work.
payload="$(cat 2>/dev/null || true)"
source_kind="startup"
if [ -n "$payload" ] && command -v jq >/dev/null 2>&1; then
  source_kind="$(printf '%s' "$payload" | jq -r '.source // "startup"' 2>/dev/null || echo startup)"
fi
case "$source_kind" in
  startup|resume|clear) : ;;
  *) exit 0 ;;
esac

today="$(date '+%Y-%m-%d')"

due="no"
if [ ! -f "$STATE" ]; then
  due="yes"   # never run
else
  last_run=""
  if command -v jq >/dev/null 2>&1; then
    last_run="$(jq -r '.last_run_ts // ""' "$STATE" 2>/dev/null || echo "")"
  fi
  last_day="${last_run%%T*}"   # YYYY-MM-DD from the ISO timestamp
  if [ -z "$last_day" ] || [ "$last_day" \< "$today" ]; then
    due="yes"
  fi
fi

[ "$due" = "yes" ] || exit 0

# Emit the nudge. No data is gathered here — the agent runs the brief in-session.
msg="Morning brief: no brief has run yet today. Offer to run it now with 'detent herald'. It covers everything since your last brief (window from .local/brief-state.json) across owl results, open PRs, active engine runs, and — in this interactive session — Jira/Gmail/Slack. Do not run it unprompted if the user is mid-task; just offer."

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg m "$msg" \
    '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$m}}'
else
  # jq absent: emit valid JSON without it (message is fixed, no escaping needed).
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$msg"
fi
exit 0
