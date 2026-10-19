#!/usr/bin/env bash
# hooks/comment-discipline.sh — advisory injection of the code-comment
# standard, on TWO events. The standard's canonical text lives in
# `skills/deslop/SKILL.md` (slop category 1); this hook carries the short,
# always-on restatement of it, so comments are written minimally the FIRST
# time instead of being stripped later by referee's deslop lens.
#
# WHY TWO EVENTS (they cover each other's blind spot):
#   SessionStart — fires before any tool call, so it covers the common case a
#     PostToolUse hook structurally cannot: a session that writes a new file
#     with its comments already in it, in ONE Write, and never writes again.
#     It does NOT fire for subagents.
#   PostToolUse (Write|Edit) — reaches subagents, which SessionStart never
#     does, and which is where detent does much of its coding (FAST-tier
#     delegation).
#   Both share ONE dedup marker, keyed per AGENT (session_id + transcript file
#   name — see the dedup block below for why session_id alone is wrong), so the
#   agent that got the rule at start does not get it again on its first write.
#   Exactly one injection per agent either way.
#
# THE RESIDUAL GAP, stated rather than papered over: for a SUBAGENT,
# PostToolUse fires AFTER the write. A subagent whose first write is also its
# only write — a new file created with its comments already in it — authors
# those comments without having seen this rule. SessionStart does not fire for
# subagents, and there is no verified pre-write injection point to use instead:
# `engine/curator-triggers/hooks.md`'s verification section covers
# SessionStart / PostToolUse / Stop and does not cover PreToolUse at all, and
# the one PreToolUse lever that is known-good is `permissionDecision` — i.e.
# BLOCKING the write, which the hook doctrine in deslop-check.sh forbids
# ("hooks must not block, spend tokens, or spawn work"). So this hook does not
# claim to cover that case. referee's deslop lens catches it at review
# instead; the two layers exist because neither is complete alone.
#
# WHY THIS HOOK DOES NOT SELF-DISABLE IN JOB / OWL RUNS (deliberate — do not
# "fix" it to match its siblings):
#   deslop-check.sh, eval-gate.sh and curator-md-nudge.sh self-disable under
#   CLAUDE_JOB_DIR / OWL_RUN because each nudges the agent to SPAWN WORK (a
#   /deslop run, an eval sweep, a curator artifact) — token spend and
#   objective drift in an unattended loop. This hook spawns nothing: it
#   injects ~70 words of authoring rule, once. The requirement it serves is
#   "every code change, universally", and headless/background/owl sessions
#   write plenty of code — excluding them would put the biggest producer of
#   code comments outside the rule. The only obligation that buys is that a
#   failure here must be SILENT (see the exit-0-on-everything discipline
#   below), because nobody is watching an owl run's stderr.
#
# Kill switches (checked FIRST, before any side effect):
#   COMMENT_DISCIPLINE=off   master off-switch for this hook (default: on)
#
# Triggers: SessionStart (unconditional) and PostToolUse on Write|Edit.
#
# Gate (PostToolUse only): `tool_input.file_path` has a code-ish extension
# (documents, data and binaries are skipped — they have no code comments to
# discipline). SessionStart has no file to gate on and is not gated.
#
# Dedup: once per AGENT, via an atomic `mkdir` marker keyed on the payload's
# `session_id` + transcript file name under
# ${DETENT_ROOT}/.local/comment-discipline/ (mkdir is the only acquisition
# primitive — same idiom as deslop-check.sh). Unlike that hook's
# (repo, head-sha) key, these never rotate, so markers are pruned by age. That
# makes the precise guarantee "once per agent per 30-day retention window",
# not "once, ever" — see the prune block for why that trade is the right one.
#
# Emission: advisory `additionalContext` only — never `decision:block`, never
# runs anything itself. ANY failure (no jq, unreadable payload, unwritable
# marker dir) exits 0 in silence; a malformed stdout would corrupt a hook
# response in a session nobody is watching.
#
# Environment:
#   DETENT_ROOT             resolved from this script's own location if unset
#   COMMENT_DISCIPLINE=off   disable this hook

set -u

SCRIPT_PATH="${BASH_SOURCE[0]}"
DETENT_ROOT="${DETENT_ROOT:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"

# --- kill switch, before any side effect -------------------------------------
[ "${COMMENT_DISCIPLINE:-on}" = "off" ] && exit 0

# --- hard dependency: no jq, no hook (silently) ------------------------------
command -v jq >/dev/null 2>&1 || exit 0

# stderr redirected: the silence guarantee above covers a failed read too, and
# an unattended session has nobody to read the complaint.
payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0

# --- which event are we? -----------------------------------------------------
# SessionStart carries no tool_input; anything else must look like a Write/Edit.
event="$(jq -r '.hook_event_name // ""' <<<"$payload" 2>/dev/null || true)"

if [ "$event" = "SessionStart" ]; then
  file_path=""
else
  event="PostToolUse"
  file_path="$(jq -r '.tool_input.file_path // ""' <<<"$payload" 2>/dev/null || true)"
  [ -n "$file_path" ] || exit 0
fi

# --- gate: code-ish file? (PostToolUse only) ---------------------------------
# Documents, data formats and binaries carry no code comments. Everything not
# on this list is treated as code — over-triggering costs at most one extra
# injection per session, under-triggering silently exempts a language.
# NOT skipped, deliberately: *.html/*.htm (HTML comments, and they routinely
# embed <script>/<style>), *.mdx (embeds JSX, so it carries real code and
# {/* comments */}) and *.yaml/*.yml/*.toml/*.ini (comment syntax, and often
# real logic). Plain *.md and *.json DO stay skipped — prose, and a format
# with no comment syntax at all.
if [ -n "$file_path" ]; then
  case "$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')" in
    *.md|*.markdown|*.rst|*.txt|*.json|*.csv|*.tsv|*.lock|\
    *.svg|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.gz) exit 0 ;;
  esac
fi

# --- dedup: once per AGENT, not once per session -----------------------------
# `session_id` alone is the wrong key: a subagent's hook payload carries the
# PARENT's session_id. Keyed on that, the parent's SessionStart would claim the
# marker and every subagent's first write would then find it taken and stay
# silent — which would leave subagents, the very thing PostToolUse is here to
# reach, permanently uncovered.
#
# So the key is session_id + the transcript file name. Each agent writes its own
# transcript, so parent and subagent land on different markers and each gets the
# rule exactly once. If a build turns out to give subagents the parent's
# transcript path too, this degrades to the old one-per-session behaviour — no
# worse than before, never a double injection.
session="$(jq -r '.session_id // ""' <<<"$payload" 2>/dev/null || true)"
transcript="$(jq -r '.transcript_path // ""' <<<"$payload" 2>/dev/null || true)"
agent=""
[ -n "$transcript" ] && agent="$(basename "$transcript" 2>/dev/null || true)"
session="${session}__${agent}"
# Neither field present (malformed payload): one fixed key, still deduped —
# repeating the rule on every single Write is worse than occasionally not.
[ "$session" = "__" ] && session="unknown-session"
# Marker names are used as a path component — keep them filesystem-safe.
session="$(printf '%s' "$session" | tr -c '[:alnum:]._-' '_')"

MARK_DIR="${DETENT_ROOT}/.local/comment-discipline"
mkdir -p "$MARK_DIR" 2>/dev/null || exit 0
# These keys never rotate, so prune or the directory grows without bound.
# Pruning is by AGE ALONE — a hook cannot observe whether an agent is still
# alive. So the honest guarantee is "once per agent per retention window", not
# "once, ever": an agent still writing 30+ days on, or a session resumed after
# that long, gets the rule a second time. That is a re-injection of ~70 words
# in a session that has already run for a month — the cheaper side of the
# trade against unbounded growth, and the reason the window is 30 days rather
# than a week.
find "$MARK_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
mkdir "${MARK_DIR}/${session}" 2>/dev/null || exit 0

jq -cn --arg ev "$event" '{
  hookSpecificOutput: {
    hookEventName: $ev,
    additionalContext: "DETENT code-comment discipline — keep code comments minimal and concise. Explain only a non-obvious why; never restate what the code already says; never narrate the change itself (no PR, ticket-status or changelog prose in source). When the why is genuinely external — a spec, a decision, a workaround for someone else'"'"'s bug — point at the ticket key instead of writing the paragraph (e.g. `// PROJ-2534`), at most once per construct, never as a per-hunk change marker. Documentation comments required by the language or repo convention on exported or public symbols (godoc, Javadoc, JSDoc/TSDoc, docstrings, licence headers) are NOT slop — keep them, and keep them short. Disable with COMMENT_DISCIPLINE=off."
  },
  suppressOutput: true
}'
exit 0
