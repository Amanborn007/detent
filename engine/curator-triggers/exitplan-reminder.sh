#!/usr/bin/env bash
# PostToolUse (ExitPlanMode) hook.
# Fires right after a plan-mode plan is approved (ExitPlanMode only runs on
# approval — a rejected plan denies the tool, so PostToolUse never fires).
# Injects context telling the model to render the approved plan as a curator
# artifact and start the feedback loop BEFORE implementing.
#
# Contract (matches the other hooks in this config):
#   stdin  = hook payload JSON (tool_name, tool_input, tool_response, ...)
#   stdout = single-line JSON with hookSpecificOutput.additionalContext,
#            or nothing for non-matching calls.
# Non-blocking: never denies or alters the tool call.
jq -c 'if (.tool_name // "") == "ExitPlanMode" then
  {continue: true,
   hookSpecificOutput: {
     hookEventName: "PostToolUse",
     additionalContext: "The plan was just approved - render it as a curator artifact and start the feedback loop before implementing. Write the plan as a self-contained HTML file under .plans/, open it with curator, and collect feedback through its poll loop before writing any code."
   }}
else empty end'
