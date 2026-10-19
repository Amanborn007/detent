#!/usr/bin/env bash
# hooks/eval-gate.sh — PostToolUse (Bash) advisory nudge, sibling to
# sentinel-autoscan.sh. Detects the moment engine-relevant paths have been
# pushed (or a PR opened) and nudges the agent to run `engine eval --changed`
# and report the verdict on the PR. NEVER runs the eval itself — hooks must
# not block, spend tokens, or spawn work on their own; this only emits a
# model-facing directive.
#
# Kill switches (checked FIRST, before any side effect):
#   EVAL_GATE=off   master off-switch for this hook (default: on)
#   OWL_RUN         any non-empty value self-disables — unattended/overnight
#                   owl loops should not get interactive PR nudges
#   CLAUDE_JOB_DIR  any non-empty value self-disables — doctrine-required for
#                   every detent hook: a background job's PostToolUse should
#                   never get an interactive PR nudge either
#
# Trigger: `git push` or `gh pr create` (same word-boundary regex family as
# sentinel-autoscan.sh) AND the merge-base diff (origin/main, falling back to
# main) touches at least one path under a suite's `select:` glob roots
# (evals/config.yaml). This is a cheap prefix check, not the full glob engine
# select.mjs uses for the real run — a false positive only costs one nudge,
# never a blocked push.
#
# Dedup: one nudge ever per (repo, head-sha), via an atomic `mkdir` marker
# under ${DETENT_ROOT}/.local/eval-gate/ (mkdir is the only acquisition
# primitive — same idiom as sentinel-autoscan.sh's scanner lock).
#
# Environment:
#   DETENT_ROOT   resolved from this script's own location if unset
#   EVAL_GATE=off  disable this hook
#   OWL_RUN        any value disables this hook (background/unattended runs)

set -u

SCRIPT_PATH="${BASH_SOURCE[0]}"
DETENT_ROOT="${DETENT_ROOT:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"

# --- kill switches, before any side effect -----------------------------------
[ "${EVAL_GATE:-on}" = "off" ] && exit 0
[ -n "${OWL_RUN:-}" ] && exit 0
[ -n "${CLAUDE_JOB_DIR:-}" ] && exit 0

payload="$(cat)"
cmd="$(jq -r '.tool_input.command // ""' <<<"$payload" 2>/dev/null || true)"
cwd="$(jq -r '.cwd // "."' <<<"$payload" 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# --- trigger: git push / gh pr create (word-boundary, sentinel-autoscan family) ---
matched=0
if [[ "$cmd" =~ (^|[^A-Za-z0-9_-])git[[:space:]]+push ]]; then matched=1; fi
if [[ "$cmd" =~ (^|[\;\&\|[:space:]])gh[[:space:]]+pr[[:space:]]+create ]]; then matched=1; fi
[ "$matched" -eq 1 ] || exit 0

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

# --- cheap glob check: does the diff touch engine-eval-relevant paths? -------
# Mirrors evals/config.yaml's `select:` glob roots (skills/**, hooks/**,
# engine/curator/**, engine/cli/**, engine/stages/**, engine/eval/**,
# evals/**, engine/sentinel/**, config/sentinel/**,
# hooks/sentinel-autoscan.sh, engine/self-feedback/** — the self-feedback
# suite's root) — prefix match only.
if ! grep -qE '^(skills/|hooks/|engine/curator/|engine/cli/|engine/stages/|engine/eval/|evals/|engine/sentinel/|config/sentinel/|engine/self-feedback/)' <<<"$changed"; then
  exit 0
fi

# --- dedup: one nudge ever per (repo, head-sha) ------------------------------
repo_slug="$(basename "$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$repo_dir")")"
MARK_DIR="${DETENT_ROOT}/.local/eval-gate"
mkdir -p "$MARK_DIR" 2>/dev/null || true
MARK="${MARK_DIR}/${repo_slug}__${head_sha}"
mkdir "$MARK" 2>/dev/null || exit 0

# --- mode-aware nudge text: never runs eval, just says what CI will do ------
# `EVAL_BLOCKING` env wins (explicit CI/operator override, same precedence as
# eval.mjs's resolveGateMode); otherwise sniff the committed shape of
# evals/config.yaml's `gate.mode` with a small awk (brittle to reformatting,
# pinned by hooks/tests/test-eval-gate.sh — worst case the wording is wrong,
# never a blocked push, since this hook never runs eval or blocks anything).
gate_mode="advisory"
if [ "${EVAL_BLOCKING:-}" = "on" ]; then
  gate_mode="blocking"
elif [ "${EVAL_BLOCKING:-}" = "off" ]; then
  gate_mode="advisory"
elif [ -f "${DETENT_ROOT}/evals/config.yaml" ]; then
  sniffed="$(awk '/^gate:/{g=1;next} g&&/^[^ ]/{g=0} g&&$1=="mode:"{print $2}' "${DETENT_ROOT}/evals/config.yaml" 2>/dev/null | head -1)"
  [ "$sniffed" = "blocking" ] && gate_mode="blocking"
fi

if [ "$gate_mode" = "blocking" ]; then
  mode_text="gate mode: blocking — a deterministic regression fails CI immediately; judge-driven DEGRADEs fail after burn-in"
else
  mode_text="gate mode: advisory"
fi

jq -cn --arg mode_text "$mode_text" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("DETENT eval-gate — engine-relevant paths were pushed. Run `engine eval --changed` and report the verdict on the PR (" + $mode_text + "). Disable with EVAL_GATE=off.")
  },
  suppressOutput: true
}'
exit 0
