#!/usr/bin/env bash
# hooks/deslop-check.sh — PostToolUse (Bash) advisory nudge, sibling to
# eval-gate.sh. Detects the moment a branch diff has been pushed and nudges
# the agent to run referee's deslop lens (`/deslop`) to strip AI slop
# (gratuitous comments, defensive try-catch on trusted paths, any-casts,
# style drift). NEVER runs the lens itself — hooks must not block, spend
# tokens, or spawn work on their own; this only emits a model-facing
# directive.
#
# Kill switches (checked FIRST, before any side effect):
#   DESLOP=off          master off-switch for this hook (default: on)
#   CLAUDE_JOB_DIR       any non-empty value self-disables — headless/job runs
#   OWL_RUN              any non-empty value self-disables — unattended/
#                         overnight owl loops should not get interactive nudges
#   PR_AUTOREVIEW=off     also disables — referee's own fix pushes use
#                         `PR_AUTOREVIEW=off git push`; without this the nudge
#                         re-fires on deslop's own cleanup push
#
# Trigger: `git push` (same word-boundary regex family as eval-gate.sh /
# sentinel-autoscan.sh). `gh pr create` is deliberately NOT a trigger here —
# sentinel-autoscan already dispatches a full referee review (which now
# includes the deslop lens) on PR create.
#
# Gate: the merge-base diff (origin/main, falling back to main) is non-empty
# AND touches at least one code-ish file (pure `*.md`/docs-only diffs are
# skipped).
#
# Dedup: one nudge per (repo, head-sha), via an atomic `mkdir` marker under
# ${DETENT_ROOT}/.local/deslop-check/ (mkdir is the only acquisition
# primitive — same idiom as eval-gate.sh).
#
# Emission: advisory `additionalContext` only — never `decision:block`, never
# runs anything itself.
#
# Environment:
#   DETENT_ROOT       resolved from this script's own location if unset
#   DESLOP=off          disable this hook
#   CLAUDE_JOB_DIR       headless/job runs disable this hook
#   OWL_RUN              any value disables this hook (background/unattended runs)
#   PR_AUTOREVIEW=off     disables this hook (referee's own fix pushes)

set -u

SCRIPT_PATH="${BASH_SOURCE[0]}"
DETENT_ROOT="${DETENT_ROOT:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"

# --- kill switches, before any side effect -----------------------------------
[ "${DESLOP:-on}" = "off" ] && exit 0
[ -n "${CLAUDE_JOB_DIR:-}" ] && exit 0
[ -n "${OWL_RUN:-}" ] && exit 0
[ "${PR_AUTOREVIEW:-on}" = "off" ] && exit 0

payload="$(cat)"
cmd="$(jq -r '.tool_input.command // ""' <<<"$payload" 2>/dev/null || true)"
cwd="$(jq -r '.cwd // "."' <<<"$payload" 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# --- trigger: git push (word-boundary, eval-gate/sentinel-autoscan family) ---
[[ "$cmd" =~ (^|[^A-Za-z0-9_-])git[[:space:]]+push ]] || exit 0

repo_dir="$cwd"
[ -d "$repo_dir" ] || repo_dir="$DETENT_ROOT"

head_sha="$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null || true)"
[ -n "$head_sha" ] || exit 0

# --- merge-base diff: prefer origin/main, fall back to main ------------------
base=""
for ref in origin/main main; do
  if git -C "$repo_dir" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    base="$ref"
    break
  fi
done
[ -n "$base" ] || exit 0

changed="$(git -C "$repo_dir" diff --name-only "$base...HEAD" 2>/dev/null || true)"
[ -n "$changed" ] || exit 0

# --- gate: does the diff touch at least one code-ish (non-docs) file? -------
if ! grep -v -E '\.md$' <<<"$changed" | grep -q .; then
  exit 0
fi

# --- dedup: one nudge per (repo, head-sha) -----------------------------------
repo_slug="$(basename "$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$repo_dir")")"
MARK_DIR="${DETENT_ROOT}/.local/deslop-check"
mkdir -p "$MARK_DIR" 2>/dev/null || true
MARK="${MARK_DIR}/${repo_slug}__${head_sha}"
mkdir "$MARK" 2>/dev/null || exit 0

jq -cn '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "DETENT deslop — you just pushed a branch diff. Run referee'"'"'s deslop lens (/deslop) to strip AI slop (gratuitous comments, defensive try-catch on trusted paths, any-casts, style drift) — it proposes removals for your approval, never auto-edits. Disable with DESLOP=off."
  },
  suppressOutput: true
}'
exit 0
