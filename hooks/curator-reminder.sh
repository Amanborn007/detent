#!/bin/bash
# PostToolUse hook on ExitPlanMode: after a plan is approved, remind the agent
# to render the approved plan in curator (the local visual review surface) and run
# its feedback loop before implementing. Degrades gracefully if curator is
# not installed yet.
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A plan was just approved (ExitPlanMode fired). If curator is available (check with: curator --help), render the approved plan as a self-contained curator artifact (.plans/<slug>.html) and run the curator feedback loop with the user before starting implementation. If curator is not installed yet, proceed normally and note that curator would have been used here."},"suppressOutput":true}
EOF
