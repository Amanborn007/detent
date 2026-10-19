#!/bin/bash
# PostToolUse hook on Write|Edit: when a large markdown review document is
# written, nudge the agent to render it as a curator artifact instead.
# Self-disables when curator is not installed and in background jobs.
command -v curator >/dev/null 2>&1 || [ -f "$HOME/.curator/enabled" ] || exit 0
[ -n "$CLAUDE_JOB_DIR" ] && exit 0
HOOK_TMP=$(mktemp "${TMPDIR:-/tmp}/curator-md.XXXXXX") || exit 0
cat > "$HOOK_TMP"
python3 - "$HOOK_TMP" <<'PY'
import sys, json, os
path = sys.argv[1]
try:
    d = json.load(open(path))
except Exception:
    d = {}
finally:
    try:
        os.remove(path)
    except OSError:
        pass
ti = d.get('tool_input') or {}
fp = ti.get('file_path') or ''
if not fp.endswith('.md'):
    sys.exit(0)
base = os.path.basename(fp).lower()
skip = {'claude.md', 'readme.md', 'notice.md', 'skill.md', 'memory.md',
        'contributing.md', 'changelog.md'}
if base in skip or '/memory/' in fp or '/.plans/' in fp or '/rules/' in fp:
    sys.exit(0)
content = ti.get('content') or ti.get('new_string') or ''
if len(content) < 4000:
    sys.exit(0)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": (
            "You just wrote a large markdown document (%s). If this is a deliverable "
            "for the user's careful review (plan, research, analysis, report), render "
            "it as a curator artifact instead: write a self-contained HTML version "
            "under .plans/ and open it with curator so the user reviews and annotates "
            "in the browser. Keep the .md only if it must live in a repo." % os.path.basename(fp)
        ),
    },
    "suppressOutput": True,
}))
PY
