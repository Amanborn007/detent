#!/bin/bash
# Stop hook: block the agent from going idle while an OPEN curator session
# still has feedback the user submitted but no poll ever delivered.
#
# Why this exists
# ---------------
# Curator feedback is durably queued on the server as `pending` in the state
# file the moment the user clicks "Send to Agent". It is only handed to the
# agent when a `curator poll` is actively waiting. If the agent finished its
# turn and stopped re-polling, later feedback sits in `pending` forever with no
# listener — the user "comes back, submits, and nothing happens". `pending > 0`
# on a non-ended session is the exact signature of stranded feedback (a live
# poll drains it to 0 on delivery), so on Stop we detect it and force a poll.
#
# Ownership scoping
# ------------------
# The curator state file is GLOBAL (one `.local/curator/state.json` for every
# session on the machine), but this hook only speaks for the CURRENT agent
# context. We only ever consider sessions whose artifact `file` path is under
# $CLAUDE_PROJECT_DIR (if set), $DETENT_ROOT (if set — curator artifacts live
# centrally under `${DETENT_ROOT}/.plans/`, see skills/curator/SKILL.md), or
# $PWD. Otherwise a background job or an unrelated session could be told to
# poll+drain feedback meant for someone else's session. If none of those three
# env vars is set at all, we cannot scope anything and fall back to the prior
# unscoped behavior (considering every session) for interactive contexts;
# background jobs are handled separately below, unconditionally, since $PWD
# (and often $CLAUDE_PROJECT_DIR) is normally inherited from the launching
# session and would otherwise make this scoping a no-op for them. Known
# limitation: since artifacts live centrally under one $DETENT_ROOT, two
# concurrent INTERACTIVE sessions sharing that root are not isolated from
# each other — this narrows the blast radius (vs. the whole machine) rather
# than eliminating it; the already-delivered fingerprint check below limits
# how much a shared-root session gets re-nagged about someone else's feedback.
#
# Already-delivered suppression
# ------------------------------
# When the curator server is alive but unreachable from a sandboxed shell,
# `curator poll` (engine/curator/cli.mjs) recovers pending feedback read-only
# from the state file WITHOUT clearing `pending` (clearing it would race the
# live server, a verified split-brain hazard) — it instead records the
# delivered payload's fingerprint in `poll-failures.json`
# (`lastDeliveredFingerprint`, see `pendingFingerprint`/`bumpPollFailure` in
# cli.mjs). We read that same file: if the current pending set's fingerprint
# already matches what was recorded as delivered, the feedback reached the
# agent even though `pending` in state.json is stale — do not re-block.
#
# Self-disables when: curator state file is absent (curator unused), the payload
# says we are already inside a stop-block (stop_hook_active, prevents loops), or
# the state file is missing/corrupt.
#
# Override the state dir with CURATOR_STATE_DIR (matches the CLI/server).

STATE_DIR="${CURATOR_STATE_DIR:-${DETENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/.local/curator}"
STATE_FILE="$STATE_DIR/state.json"
POLL_FAILURES_FILE="$STATE_DIR/poll-failures.json"
[ -f "$STATE_FILE" ] || exit 0

# A background job never owns an interactive curator session (no browser to
# poll from) and must never be forced to drain feedback on another session's
# behalf. This check is unconditional — not just when ownership env vars are
# unset — because $PWD (and often $CLAUDE_PROJECT_DIR) is normally inherited
# from the launching interactive session, so scoping alone would not stop a
# background job from matching and blocking on that session's artifacts.
[ -n "${CLAUDE_JOB_DIR:-}" ] && exit 0

HOOK_TMP=$(mktemp "${TMPDIR:-/tmp}/curator-pending.XXXXXX") || exit 0
cat > "$HOOK_TMP"

python3 - "$HOOK_TMP" "$STATE_FILE" "$POLL_FAILURES_FILE" \
  "${CLAUDE_PROJECT_DIR:-}" "${DETENT_ROOT:-}" "${PWD:-}" <<'PY'
import sys, json, os, hashlib

payload_path, state_path, failures_path = sys.argv[1], sys.argv[2], sys.argv[3]
owned_raw = sys.argv[4:7]

try:
    payload = json.load(open(payload_path))
except Exception:
    payload = {}
finally:
    try:
        os.remove(payload_path)
    except OSError:
        pass

# Never re-block on the immediate re-stop after we already blocked once.
if payload.get('stop_hook_active'):
    sys.exit(0)

try:
    state = json.load(open(state_path))
except Exception:
    sys.exit(0)  # missing/corrupt state must never block a stop


def norm(p):
    if not p:
        return None
    p = os.path.realpath(p)
    return p.rstrip('/') or '/'


owned_prefixes = [p for p in (norm(x) for x in owned_raw) if p]


def owned(file_path):
    # No scoping info at all (both env vars and PWD unset): fall back to the
    # prior unscoped behavior rather than silently going blind.
    if not owned_prefixes:
        return True
    fp = norm(file_path)
    if not fp:
        return False
    for prefix in owned_prefixes:
        sep_prefix = prefix if prefix == '/' else prefix + '/'
        if fp == prefix or fp.startswith(sep_prefix):
            return True
    return False


try:
    failures = json.load(open(failures_path))
except Exception:
    failures = {}  # missing/corrupt counter file must never block or unblock


def already_delivered(file_key, session):
    entry = failures.get(file_key)
    if not isinstance(entry, dict):
        return False
    sid = session.get('id')
    if not sid:
        return False
    # Mirrors cli.mjs's pendingFingerprint(session): sha256(id + JSON.stringify(pending)).
    fingerprint = hashlib.sha256(
        (str(sid) + json.dumps(session.get('pending'), separators=(',', ':'), ensure_ascii=False)).encode('utf-8')
    ).hexdigest()
    return entry.get('lastDeliveredFingerprint') == fingerprint


sessions = state.get('sessions') or {}
stranded = []
for key, s in sessions.items():
    if not isinstance(s, dict):
        continue
    if s.get('ended'):
        continue
    pending = s.get('pending') or []
    if not (isinstance(pending, list) and len(pending) > 0):
        continue
    file_path = s.get('file') or key
    if not owned(file_path):
        continue
    if already_delivered(key, s):
        continue
    stranded.append((file_path, len(pending)))

if not stranded:
    sys.exit(0)

lines = "\n".join(f'  - {f} ({n} pending item(s))' for f, n in stranded)
files = ", ".join(f for f, _ in stranded)
poll_cmd = 'node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" poll'
reply_cmd = 'node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" reply'
reason = (
    "Curator has feedback you have NOT delivered to the agent yet. These open "
    "curator session(s) hold user feedback queued in the state file that no "
    "poll consumed:\n"
    f"{lines}\n\n"
    "This is exactly how curator feedback gets silently dropped: the user "
    "submitted while no `curator poll` was waiting. Do NOT stop. Run "
    f"`{poll_cmd} <file>` for each of the above ({files}) to receive and "
    f"apply the feedback, then `{reply_cmd} <file> -m \"<what you changed>\"` "
    "and poll again. Only stop once every open session is drained (or ended)."
)
print(json.dumps({"decision": "block", "reason": reason}))
PY
