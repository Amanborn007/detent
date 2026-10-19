#!/usr/bin/env bash
# hooks/voice-discipline.sh — advisory injection of the user's authored-prose
# voice, on TWO events. Sibling of comment-discipline.sh, and deliberately its
# COMPLEMENT: that hook gates on code-ish files and skips *.md/*.rst/*.txt;
# this one gates on exactly those and skips code. Between them, every file a
# Write/Edit can produce is covered by one rule or the other, never both.
#
# WHY THIS EXISTS AT ALL. The voice rules may already be written down — in the
# file named by `voice.file` in `detent.user.yaml` (authored surfaces) and in
# scribe's profile file (reply surfaces, loaded by scribe). The failure mode this hook addresses is not missing knowledge:
# it is that a file read once at session start loses to whatever is in immediate
# context forty tool calls later. Observed repeatedly — an agent told the voice
# rule at start, corrected mid-session, and drifting back within a few turns.
# So the rule is re-asserted at the moment prose is being written, not only at
# the moment the session begins.
#
# WHY TWO EVENTS (same reasoning as comment-discipline.sh):
#   SessionStart — fires before any tool call, covering the session that writes
#     one document and never writes again. Does NOT fire for subagents.
#   PostToolUse (Write|Edit) — reaches subagents, which SessionStart never does.
#   One shared dedup marker keyed per AGENT, so an agent that got the rule at
#   start does not get it again on its first write.
#
# THE RESIDUAL GAPS, stated rather than papered over:
#   1. For a SUBAGENT, PostToolUse fires AFTER the write. A subagent whose only
#      write is a new document authors it without having seen this. Same gap the
#      sibling hook documents, same reason: no verified pre-write injection point
#      exists that is not `permissionDecision` (i.e. blocking), and the hook
#      doctrine forbids blocking.
#   2. This hook cannot reach the surfaces that are NOT files: Slack drafts,
#      GitHub PR/issue comments, commit messages, Jira descriptions. Those go
#      through MCP tools and Bash, where there is no reliable content gate that
#      does not also fire on every unrelated call. scribe covers the reply
#      surfaces by loading its profile; commit messages and ticket descriptions
#      are covered only by CLAUDE.md and by review. Naming the gap is the point
#      — a hook that claimed to cover them would be worse than one that does not.
#
# WHY IT DOES NOT SELF-DISABLE IN JOB / OWL RUNS: identical to
# comment-discipline.sh — it spawns no work, it injects a short rule once. The
# requirement is "every human-read document, universally", and unattended runs
# author plenty of prose. The obligation that buys is that failure must be
# SILENT, since nobody reads an owl run's stderr.
#
# Kill switches (checked FIRST, before any side effect):
#   VOICE_DISCIPLINE=off   master off-switch for this hook (default: on)
#
# Triggers: SessionStart (unconditional) and PostToolUse on Write|Edit.
#
# Gate (PostToolUse only): `tool_input.file_path` has a prose extension.
# Code, data and binaries are skipped — they are comment-discipline.sh's job.
#
# Dedup: once per AGENT, atomic `mkdir` marker keyed on `session_id` +
# transcript file name under ${DETENT_ROOT}/.local/voice-discipline/, pruned
# by age at 30 days. Same idiom, same honest guarantee as the sibling hook:
# "once per agent per retention window", not "once, ever".
#
# Emission: advisory `additionalContext` only — never `decision:block`, never
# runs anything. ANY failure exits 0 in silence.
#
# Environment:
#   DETENT_ROOT           resolved from this script's own location if unset
#   VOICE_DISCIPLINE=off   disable this hook

set -u

SCRIPT_PATH="${BASH_SOURCE[0]}"
DETENT_ROOT="${DETENT_ROOT:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"

# --- kill switch, before any side effect -------------------------------------
[ "${VOICE_DISCIPLINE:-on}" = "off" ] && exit 0

# --- hard dependency: no jq, no hook (silently) ------------------------------
command -v jq >/dev/null 2>&1 || exit 0

payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0

# --- which event are we? -----------------------------------------------------
event="$(jq -r '.hook_event_name // ""' <<<"$payload" 2>/dev/null || true)"

if [ "$event" = "SessionStart" ]; then
  file_path=""
else
  event="PostToolUse"
  file_path="$(jq -r '.tool_input.file_path // ""' <<<"$payload" 2>/dev/null || true)"
  [ -n "$file_path" ] || exit 0
fi

# --- gate: prose file? (PostToolUse only) ------------------------------------
# ALLOWLIST, not a skip list — the inverse of comment-discipline.sh, which
# treats everything unlisted as code. Here everything unlisted is code and is
# skipped, so a new prose format silently opts out rather than a new language
# silently getting the wrong rule. *.mdx is NOT included: it embeds JSX, so the
# sibling hook owns it.
if [ -n "$file_path" ]; then
  case "$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')" in
    *.md|*.markdown|*.rst|*.txt|*.adoc) : ;;
    *) exit 0 ;;
  esac
fi

# --- dedup: once per AGENT, not once per session -----------------------------
# `session_id` alone is the wrong key: a subagent's payload carries the PARENT's
# session_id, so the parent's SessionStart would claim the marker and every
# subagent would then stay silent — leaving subagents, the thing PostToolUse is
# here to reach, uncovered. Keyed on session_id + transcript file name instead.
session="$(jq -r '.session_id // ""' <<<"$payload" 2>/dev/null || true)"
transcript="$(jq -r '.transcript_path // ""' <<<"$payload" 2>/dev/null || true)"
agent=""
[ -n "$transcript" ] && agent="$(basename "$transcript" 2>/dev/null || true)"
session="${session}__${agent}"
[ "$session" = "__" ] && session="unknown-session"
session="$(printf '%s' "$session" | tr -c '[:alnum:]._-' '_')"

MARK_DIR="${DETENT_ROOT}/.local/voice-discipline"
mkdir -p "$MARK_DIR" 2>/dev/null || exit 0
find "$MARK_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
mkdir "${MARK_DIR}/${session}" 2>/dev/null || exit 0

# voice.file in detent.user.yaml (block or inline form); null/empty/~ means unset.
voice_file=""
USER_CFG="${DETENT_ROOT}/detent.user.yaml"
if [ -f "$USER_CFG" ]; then
  voice_file="$(awk '
    /^voice:[ \t]*\{/ { if (match($0, /file:[ \t]*[^,}]*/)) { v=substr($0, RSTART+5, RLENGTH-5); print v; exit } }
    /^voice:[ \t]*$/ { b=1; next }
    b && /^[^ \t#]/ { b=0 }
    b && /^[ \t]+file:/ { sub(/^[ \t]+file:[ \t]*/, ""); print; exit }
  ' "$USER_CFG" 2>/dev/null || true)"
  voice_file="$(printf '%s' "$voice_file" | sed -e 's/[ \t]*#.*$//' -e "s/[\"']//g" -e 's/^[ \t]*//' -e 's/[ \t]*$//')"
  case "$voice_file" in null|Null|NULL|"~") voice_file="" ;; esac
fi

rules_ref=""
[ -n "$voice_file" ] && rules_ref=" Full rules: ${voice_file} — read it before drafting."

jq -cn --arg ev "$event" --arg ref "$rules_ref" '{
  hookSpecificOutput: {
    hookEventName: $ev,
    additionalContext: ("DETENT voice discipline — anything a human will read is written in the user'"'"'s voice, not the model'"'"'s." + $ref + " General writing guidance: lead with the answer or the ask, not the status; say what happens and why in plain words; one claim per point; cut anything the reader cannot act on; name the system and where it lives before quoting an identifier; one ask per message; no filler or report-style phrasing. Concise means few claims, not clipped words. In curator artifacts, shape follows the content: a table only where the shape carries the meaning, and `make it simpler` means cut whole sections rather than shorten sentences. Disable with VOICE_DISCIPLINE=off.")
  },
  suppressOutput: true
}'
exit 0
