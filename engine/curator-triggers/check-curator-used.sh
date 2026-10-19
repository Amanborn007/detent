#!/usr/bin/env bash
# Stop hook: detect "a plan/research artifact was produced this turn, but
# curator was never opened" and block the stop once so the model finishes
# the loop.
#
# Contract:
#   stdin  = Stop hook payload JSON:
#            { session_id, transcript_path, hook_event_name: "Stop",
#              stop_hook_active }
#   stdout = {"decision":"block","reason":"..."} to make the model continue,
#            or nothing (allow the stop).
#   exit 1 + stderr on abnormal input (missing/unreadable transcript) —
#            non-blocking error, surfaced in verbose mode.
#
# Detection (over the tail of the session transcript, current turn only —
# i.e. lines after the last real user prompt):
#   artifact produced =
#     - Write/Edit/MultiEdit/NotebookEdit tool_use whose file_path matches
#       CURATOR_ARTIFACT_RE (default: a path under .plans/), OR
#     - an ExitPlanMode tool_use that was NOT rejected (no is_error
#       tool_result for its id) — i.e. a plan was finalized this turn.
#   curator opened =
#     - Bash tool_use whose command matches CURATOR_INVOKE_RE
#       (default: the word "curator"), OR
#     - Skill tool_use for a curator/curator skill, OR
#     - any tool whose name mentions curator (future MCP tool).
#
# Loop guard: if stop_hook_active is true (we already blocked once this
# stoppage), always allow — a Stop hook that blocks unconditionally would
# otherwise wedge the session.
#
# Tunables (env):
#   CURATOR_ARTIFACT_RE  regex for artifact paths   (default "(^|/)[.]plans/")
#   CURATOR_INVOKE_RE    regex for invoke commands  (default "\bcurator\b")
#   CURATOR_CHECK_TAIL   transcript lines scanned   (default 2000)
set -euo pipefail

payload="$(cat)"

stop_active="$(jq -r '.stop_hook_active // false' <<<"$payload")"
if [ "$stop_active" = "true" ]; then
  exit 0
fi

transcript="$(jq -r '.transcript_path // empty' <<<"$payload")"
if [ -z "$transcript" ]; then
  echo "check-curator-used: no transcript_path in hook payload" >&2
  exit 1
fi
if [ ! -r "$transcript" ]; then
  echo "check-curator-used: transcript not readable: $transcript" >&2
  exit 1
fi

# -R + fromjson? drops any malformed line instead of aborting the whole scan
tail -n "${CURATOR_CHECK_TAIL:-2000}" "$transcript" \
  | jq -cR 'fromjson? // empty' \
  | jq -s -c \
  --arg artifact_re "${CURATOR_ARTIFACT_RE:-(^|/)[.]plans/}" \
  --arg invoke_re "${CURATOR_INVOKE_RE:-\\bcurator\\b}" '
  [ .[] | select(type == "object") ] as $lines

  # Index of the last real user prompt: a user line that is not meta and is
  # not a tool_result carrier. Everything after it is the current turn.
  | ([ range(0; $lines | length) | select(
        $lines[.].type == "user"
        and ($lines[.].isMeta != true)
        and ( (($lines[.].message.content) | type) == "string"
              or ( (($lines[.].message.content) | type) == "array"
                   and ([ $lines[.].message.content[]?
                          | select(.type == "tool_result") ] | length) == 0 ) )
      ) ] | if length > 0 then .[length - 1] else -1 end) as $last_user

  # ids of tool calls that errored / were rejected (searched across the whole
  # tail so a rejected ExitPlanMode never counts as a finalized plan)
  | [ $lines[].message.content[]?
      | select(.type == "tool_result" and .is_error == true)
      | .tool_use_id ] as $error_ids

  # tool_use blocks in the current turn
  | [ $lines[($last_user + 1):][]
      | select(.type == "assistant")
      | .message.content[]?
      | select(.type == "tool_use") ] as $uses

  | ([ $uses[] | select(
        ( (.name == "Write" or .name == "Edit"
           or .name == "MultiEdit" or .name == "NotebookEdit")
          and ((.input.file_path // "") | test($artifact_re)) )
        or ( .name == "ExitPlanMode"
             and ((.id // "") as $id | ($error_ids | index($id)) == null) )
      ) ] | length) as $artifacts

  | ([ $uses[] | select(
        ( .name == "Bash" and ((.input.command // "") | test($invoke_re)) )
        or ( .name == "Skill"
             and ((.input.skill // "") | test("curator|curator")) )
        or ((.name // "") | test("curator"; "i"))
      ) ] | length) as $opened

  | if $artifacts > 0 and $opened == 0 then
      {decision: "block",
       reason: "A plan/research artifact was produced this turn (or a plan was just approved) but curator was never opened. Render the deliverable as a self-contained HTML artifact under .plans/, open it with curator, and start the feedback poll loop now. If curator is not installed, say so explicitly and leave the .md fallback."}
    else empty end'
