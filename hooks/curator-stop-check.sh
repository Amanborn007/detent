#!/bin/bash
# Stop hook: if the turn's final output was long and review-shaped but no
# curator session was opened, block once with instructions to render it as
# a curator artifact. Self-disables when curator is not installed, in
# background jobs, and on the re-stop after a block (stop_hook_active).
command -v curator >/dev/null 2>&1 || [ -f "$HOME/.curator/enabled" ] || exit 0
[ -n "$CLAUDE_JOB_DIR" ] && exit 0
HOOK_TMP=$(mktemp "${TMPDIR:-/tmp}/curator-stop.XXXXXX") || exit 0
cat > "$HOOK_TMP"
python3 - "$HOOK_TMP" <<'PY'
import sys, json, os
from collections import deque
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception:
    data = {}
finally:
    try:
        os.remove(path)
    except OSError:
        pass
if data.get('stop_hook_active'):
    sys.exit(0)
tp = data.get('transcript_path') or ''
if not tp or not os.path.exists(tp):
    sys.exit(0)
try:
    lines = deque(open(tp, errors='ignore'), maxlen=2000)
except Exception:
    sys.exit(0)
events = []
for ln in lines:
    try:
        events.append(json.loads(ln))
    except Exception:
        pass
last_user = None
for i in range(len(events) - 1, -1, -1):
    e = events[i]
    if e.get('type') == 'user' and not e.get('isSidechain'):
        m = e.get('message') or {}
        c = m.get('content')
        if isinstance(c, str) and c.strip():
            last_user = i
            break
        if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'text' for b in c):
            last_user = i
            break
if last_user is None:
    sys.exit(0)
chars = 0
curator_used = False
for e in events[last_user + 1:]:
    if e.get('isSidechain'):
        continue
    if e.get('type') == 'assistant':
        m = e.get('message') or {}
        for b in (m.get('content') or []):
            if isinstance(b, dict):
                if b.get('type') == 'text':
                    chars += len(b.get('text') or '')
                elif b.get('type') == 'tool_use':
                    s = json.dumps(b.get('input') or {})
                    if 'curator' in s or '.plans/' in s:
                        curator_used = True
if curator_used or chars < 3500:
    sys.exit(0)
print(json.dumps({
    "decision": "block",
    "reason": (
        "Review-surface rule: your response this turn was long (~%d chars of text) "
        "and no curator session was opened. If this output is a deliverable for the "
        "user's careful review (plan, research report, analysis, comparison, design "
        "options, status report), write it as a self-contained HTML artifact under "
        ".plans/, open it with curator, run the curator feedback loop, and reply "
        "with a one-paragraph pointer instead of the full text. If it is NOT such a "
        "deliverable (conversation, code output, quick answer), simply provide your "
        "final message again unchanged." % chars
    ),
}))
PY
