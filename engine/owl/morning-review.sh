#!/usr/bin/env bash
# morning-review.sh <run_dir> — build the self-contained curator artifact for
# a finished owl run: a prominent "Decisions I made for you" section at
# the top (one accept/pivot block per provisional decision from
# decisions.jsonl — the never-halt contract), then one card per iteration
# with accept/reject decision blocks per commit, under an explicit
# "stop-condition claims are UNVERIFIED" banner. Prints the artifact path
# on stdout.
#
# All untrusted text (objective, summaries, learnings) is HTML-escaped with
# jq's @html; nothing is shell-interpolated.
set -u -o pipefail

die() { printf 'morning-review: ERROR: %s\n' "$*" >&2; exit 1; }

RUN_DIR="${1:?usage: morning-review.sh <run_dir>}"
META="$RUN_DIR/run-meta.json"
JSONL="$RUN_DIR/iterations.jsonl"
DECISIONS_JSONL="$RUN_DIR/decisions.jsonl"   # absent => no provisional decisions
[[ -f "$META" ]] || die "missing $META"
[[ -f "$JSONL" ]] || die "missing $JSONL"
command -v jq >/dev/null 2>&1 || die "jq is required"

esc() { jq -rn --arg t "$1" '$t | @html'; }
meta() { jq -r "$1" "$META"; }

REPO="$(meta '.repo')"
[[ -d "$REPO" ]] || die "repo from run-meta does not exist: $REPO"

DATE="$(date +%Y-%m-%d)"
mkdir -p "$REPO/.plans"
OUT="$REPO/.plans/owl-review-$DATE.html"
if [[ -e "$OUT" ]]; then
  OUT="$REPO/.plans/owl-review-$DATE-$(date +%H%M%S).html"
fi

E_OBJECTIVE="$(esc "$(meta '.objective')")"
E_STOP_WHEN="$(esc "$(meta '.stop_when // ""')")"
E_BRANCH="$(esc "$(meta '.branch')")"
E_REPO="$(esc "$REPO")"
E_RUN_ID="$(esc "$(meta '.run_id')")"
E_HALT="$(esc "$(meta '.halt_reason // "unknown"')")"
E_STARTED="$(esc "$(meta '.started_at // ""')")"
E_ENDED="$(esc "$(meta '.ended_at // ""')")"
ITER_COUNT="$(meta '.iterations_run // 0')"
COMMIT_COUNT="$(meta '.commits_made // 0')"

{
cat <<'HTMLHEAD'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
HTMLHEAD
printf '<title>Owl review: %s</title>\n' "$E_BRANCH"
cat <<'HTMLSTYLE'
<style>
  :root {
    color-scheme: light dark;
    --ink: #1b1e23; --paper: #fbfbfa; --muted: #5b6470; --line: #d9dde3;
    --accent: #2563c9; --good: #1d7a3d; --warn: #9a6200; --bad: #b3362b;
    --chip: #eef1f5;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e8eaed; --paper: #191b1f; --muted: #9aa3ae; --line: #33383f; --chip: #23262b; }
  }
  * { box-sizing: border-box; min-width: 0; }
  body { margin: 0; padding: 32px 20px 80px; background: var(--paper); color: var(--ink);
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  h1 { font-size: 24px; margin: 0; letter-spacing: -.01em; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 8px; }
  p { margin: 0 0 8px; }
  .meta { color: var(--muted); font-size: 13px; }
  section { border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .banner { border: 2px solid var(--bad); background: var(--chip); border-radius: 12px; padding: 14px 18px; }
  .banner b { color: var(--bad); text-transform: uppercase; letter-spacing: .04em; }
  .decisions { border: 2px solid var(--warn); }
  .decisions > h2 { color: var(--warn); font-size: 16px; }
  .decision { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-top: 12px; }
  .decision h3 { margin: 0 0 4px; font-size: 15px; }
  .iter { border-left: 4px solid var(--good); }
  .iter.failure { border-left-color: var(--bad); }
  .status { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .iter .status { color: var(--good); }
  .iter.failure .status { color: var(--bad); }
  code { background: var(--chip); border-radius: 4px; padding: 1px 5px; font-size: 13px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin: 3px 0; }
  .options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
  @media (max-width: 620px) { .options { grid-template-columns: 1fr; } }
  .option { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; cursor: pointer; }
  .option h3 { margin: 0 0 4px; font-size: 14px; }
  .hint { font-size: 12.5px; color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<main>
HTMLSTYLE

printf '  <header>\n    <h1>Owl run review — %s</h1>\n' "$E_RUN_ID"
printf '    <p class="meta">branch <code>%s</code> · repo <code>%s</code> · %s → %s · %s iterations, %s commits</p>\n' \
  "$E_BRANCH" "$E_REPO" "$E_STARTED" "$E_ENDED" "$ITER_COUNT" "$COMMIT_COUNT"
printf '  </header>\n'

# --- "Decisions I made for you" — never-halt provisional decisions, rendered
# --- FIRST so the human sees every autonomous call before the iteration cards.
DECISION_COUNT=0
[[ -s "$DECISIONS_JSONL" ]] && DECISION_COUNT="$(jq -s 'length' "$DECISIONS_JSONL")"
if [[ "$DECISION_COUNT" -gt 0 ]]; then
  printf '  <section class="decisions">\n'
  printf '    <h2>Decisions I made for you</h2>\n'
  printf '    <p>The loop hit <b>%s</b> major decision(s) it could not make and, per the never-halt contract, picked a defensible provisional path and kept working. Review each one: <b>Accept</b> keeps the path; <b>Pivot</b> means annotate it with the direction you actually want (extra pointers welcome).</p>\n' "$DECISION_COUNT"
  while IFS= read -r dline; do
    [[ -z "$dline" ]] && continue
    d_id="$(printf '%s' "$dline" | jq -r '.id // ""')"
    d_iter="$(printf '%s' "$dline" | jq -r '.iteration // 0')"
    e_id="$(esc "$d_id")"
    e_needed="$(printf '%s' "$dline" | jq -r '.decision_needed // "" | @html')"
    e_choice="$(printf '%s' "$dline" | jq -r '.provisional_choice // "" | @html')"
    e_rationale="$(printf '%s' "$dline" | jq -r '.rationale // "" | @html')"
    e_rev="$(printf '%s' "$dline" | jq -r '.reversibility // "unknown" | @html')"
    d_commit="$(jq -r --argjson n "$d_iter" 'select(.n == $n) | .commit // ""' "$JSONL" | head -1)"
    e_commit="$(esc "$d_commit")"
    options_html="$(printf '%s' "$dline" | jq -r '(.options_considered // [])[] | "        <li>" + (tostring | @html) + "</li>"')"
    printf '    <div class="decision">\n'
    printf '      <h3>%s — %s</h3>\n' "$e_id" "$e_needed"
    printf '      <p class="meta">iteration %s%s · reversibility: %s</p>\n' \
      "$d_iter" "${e_commit:+ · commit <code>$e_commit</code>}" "$e_rev"
    printf '      <p><b>Provisional choice:</b> %s</p>\n' "$e_choice"
    printf '      <p><b>Rationale:</b> %s</p>\n' "$e_rationale"
    if [[ -n "$options_html" ]]; then
      printf '      <p><b>Options considered:</b></p>\n      <ul>\n%s\n      </ul>\n' "$options_html"
    fi
    printf '      <div data-plan-question="decision-%s">\n' "$e_id"
    printf '        <p class="hint">Decide on this provisional call (click an option):</p>\n'
    printf '        <div class="options">\n'
    printf '          <div class="option" data-plan-option="Accept"><h3>Accept</h3><p>Keep the provisional path for %s.</p></div>\n' "$e_id"
    printf '          <div class="option" data-plan-option="Pivot"><h3>Pivot</h3><p>Change direction — annotate with pointers for the redo.</p></div>\n'
    printf '        </div>\n      </div>\n'
    printf '    </div>\n'
  done < "$DECISIONS_JSONL"
  printf '  </section>\n'
fi

printf '  <div class="banner"><b>Stop-condition claims are UNVERIFIED</b><p>Every “success” below is the agent’s own claim, gated only by “the diff was not empty”. The orchestrator verified nothing else — not tests, not the stop condition, not the summaries. Distrust the stop condition: check the commits yourself before accepting.</p></div>\n'

printf '  <section id="run">\n    <h2>Run</h2>\n'
printf '    <p><b>Objective:</b> %s</p>\n' "$E_OBJECTIVE"
if [[ -n "$E_STOP_WHEN" ]]; then
  printf '    <p><b>Stop condition (as given):</b> %s</p>\n' "$E_STOP_WHEN"
fi
printf '    <p><b>Halt reason:</b> %s</p>\n' "$E_HALT"
printf '  </section>\n'

ITER_N=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  ITER_N=$((ITER_N + 1))
  n="$(printf '%s' "$line" | jq -r '.n')"
  status="$(printf '%s' "$line" | jq -r '.status')"
  commit="$(printf '%s' "$line" | jq -r '.commit // ""')"
  stop_claimed="$(printf '%s' "$line" | jq -r '.stop_claimed // false')"
  e_summary="$(printf '%s' "$line" | jq -r '.summary // "" | @html')"
  e_reason="$(printf '%s' "$line" | jq -r '.reason // "" | @html')"
  e_commit="$(esc "$commit")"
  cls="iter"; label="success"
  [[ "$status" != "success" ]] && { cls="iter failure"; label="failure"; }

  printf '  <section class="%s">\n' "$cls"
  printf '    <h2>Iteration %s <span class="status">%s</span></h2>\n' "$n" "$label"
  if [[ -n "$commit" ]]; then
    printf '    <p><b>Commit:</b> <code>%s</code> — %s</p>\n' "$e_commit" "$e_summary"
  elif [[ -n "$e_summary" ]]; then
    printf '    <p><b>Summary (no commit):</b> %s</p>\n' "$e_summary"
  fi
  [[ -n "$e_reason" ]] && printf '    <p><b>Reason:</b> %s</p>\n' "$e_reason"

  changes_html="$(printf '%s' "$line" | jq -r '(.key_changes // [])[] | "      <li>" + (tostring | @html) + "</li>"')"
  if [[ -n "$changes_html" ]]; then
    printf '    <p><b>Claimed changes:</b></p>\n    <ul>\n%s\n    </ul>\n' "$changes_html"
  fi
  learnings_html="$(printf '%s' "$line" | jq -r '(.key_learnings // [])[] | "      <li>" + (tostring | @html) + "</li>"')"
  if [[ -n "$learnings_html" ]]; then
    printf '    <p><b>Claimed learnings:</b></p>\n    <ul>\n%s\n    </ul>\n' "$learnings_html"
  fi
  if [[ "$stop_claimed" == "true" ]]; then
    printf '    <p><b class="status">Agent claimed the stop condition is met — UNVERIFIED.</b></p>\n'
  fi
  dec_ids="$(printf '%s' "$line" | jq -r '(.decision_ids // []) | join(" ")')"
  if [[ -n "$dec_ids" ]]; then
    printf '    <p><b>Provisional decisions:</b> %s — review them in the “Decisions I made for you” section above.</p>\n' "$(esc "$dec_ids")"
  fi

  if [[ -n "$commit" ]]; then
    printf '    <div data-plan-question="commit-%s-%s">\n' "$n" "$e_commit"
    printf '      <p class="hint">Decide on this commit (click an option):</p>\n'
    printf '      <div class="options">\n'
    printf '        <div class="option" data-plan-option="Accept"><h3>Accept</h3><p>Keep commit <code>%s</code> on <code>%s</code>.</p></div>\n' "$e_commit" "$E_BRANCH"
    printf '        <div class="option" data-plan-option="Reject"><h3>Reject</h3><p>Drop it (revert or rebase it out) before merging.</p></div>\n'
    printf '      </div>\n    </div>\n'
  fi
  printf '  </section>\n'
done < "$JSONL"

if [[ "$ITER_N" -eq 0 ]]; then
  printf '  <section><h2>Iterations</h2><p>No iterations ran.</p></section>\n'
fi

printf '</main>\n</body>\n</html>\n'
} > "$OUT" || die "failed writing $OUT"

printf '%s\n' "$OUT"
