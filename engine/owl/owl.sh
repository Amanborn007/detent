#!/usr/bin/env bash
# owl.sh — external orchestrator for unattended overnight Claude Code loops.
#
# The orchestrator owns everything the agent must not: git (branch, commit,
# rollback), iteration/wall-clock caps, the kill switch, the notes file, and
# the morning-review artifact. The agent runs headless (`claude -p`) once per
# iteration under a scoped permission settings file — never with a
# permissions-bypass flag — and reports through a strict JSON contract:
#   {success, summary, key_changes, key_learnings, provisional_decisions,
#    should_fully_stop}
#
# Never-halt contract: when the agent hits a major decision it cannot make,
# it does NOT stop — it picks a defensible provisional path, reports it in
# provisional_decisions, and keeps working. The orchestrator journals each
# decision of a committed iteration to .owl/<run>/decisions.jsonl
# ({id, iteration, decision_needed, options_considered, provisional_choice,
# rationale, reversibility}), tags the commit with [PROVISIONAL D-n], and the
# morning review renders every decision for human accept/pivot. Provisional
# autonomy never widens the sandbox: destructive/irreversible/security-
# sensitive actions stay forbidden regardless.
#
# Usage:
#   owl.sh --objective "<text>" --repo <path>
#              [--max-iterations N=8] [--max-minutes M=300]
#              [--stop-when "<condition text>"]
#              [--claude-bin <path>] [--profile <name>=default]
#              [--settings-file <path>]
#
# Permission profiles live in profiles/<name>.json (JSON passed verbatim to
# `claude -p --settings`). Resolution order: --settings-file (back-compat,
# always wins if given) > --profile <name> > default. Every resolved file —
# regardless of which flag chose it — is run through validate_profile()
# before anything else happens: bypass-permissions and blanket-Bash/bare-
# network-tool grants are refused, never silently narrowed.
#
# Env (mainly for tests):
#   OWL_CLAUDE_BIN     alternative claude binary (--claude-bin wins)
#   OWL_MAX_SECONDS    overrides --max-minutes with a seconds budget
#   OWL_NO_CAFFEINATE  set to 1 to skip the macOS caffeinate wrapper
#
# Argv-safety rule: untrusted text (objective, stop condition, agent output)
# is only ever passed as single argv elements or via printf/jq --arg — it is
# never interpolated into a shell-evaluated string, eval, or expanded heredoc.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { printf 'owl: ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- args
OBJECTIVE=""
REPO=""
MAX_ITERATIONS=8
MAX_MINUTES=300
STOP_WHEN=""
CLAUDE_BIN="${OWL_CLAUDE_BIN:-claude}"
PROFILE="default"
SETTINGS_FILE=""
SETTINGS_FILE_EXPLICIT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --objective)      OBJECTIVE="${2:?--objective needs a value}"; shift 2 ;;
    --repo)           REPO="${2:?--repo needs a value}"; shift 2 ;;
    --max-iterations) MAX_ITERATIONS="${2:?--max-iterations needs a value}"; shift 2 ;;
    --max-minutes)    MAX_MINUTES="${2:?--max-minutes needs a value}"; shift 2 ;;
    --stop-when)      STOP_WHEN="${2:?--stop-when needs a value}"; shift 2 ;;
    --claude-bin)     CLAUDE_BIN="${2:?--claude-bin needs a value}"; shift 2 ;;
    --profile)        PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --settings-file)  SETTINGS_FILE_EXPLICIT="${2:?--settings-file needs a value}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$OBJECTIVE" ]] || die "--objective is required"
[[ -n "$REPO" ]] || die "--repo is required"
[[ -d "$REPO" ]] || die "repo does not exist: $REPO"
REPO="$(cd "$REPO" && pwd)"
[[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]] || die "--max-iterations must be an integer"
[[ "$MAX_MINUTES" =~ ^[0-9]+$ ]] || die "--max-minutes must be an integer"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "claude binary not found: $CLAUDE_BIN"

# --settings-file (back-compat) always wins over --profile if given;
# otherwise resolve --profile against profiles/<name>.json.
if [[ -n "$SETTINGS_FILE_EXPLICIT" ]]; then
  SETTINGS_FILE="$SETTINGS_FILE_EXPLICIT"
else
  SETTINGS_FILE="$SCRIPT_DIR/profiles/$PROFILE.json"
fi
if [[ ! -f "$SETTINGS_FILE" ]]; then
  AVAILABLE="$(cd "$SCRIPT_DIR/profiles" 2>/dev/null && printf '%s\n' *.json | sed -E 's/\.json$//' | paste -sd ',' -)"
  die "settings file not found: $SETTINGS_FILE (available profiles: ${AVAILABLE:-none found in $SCRIPT_DIR/profiles})"
fi

validate_profile() { # $1=settings file path; dies on any violation
  local f="$1"
  jq -e . "$f" >/dev/null 2>&1 || die "profile is not valid JSON: $f"
  if jq -e '
      (.permissions.defaultMode // "") == "bypassPermissions"
      or ([.. | objects | .defaultMode? // empty] | any(. == "bypassPermissions"))
    ' "$f" >/dev/null 2>&1; then
    die "profile $f sets defaultMode: bypassPermissions — banned for owl even for unattended runs (see README)"
  fi
  if jq -e '(.permissions.allow // []) | any(. == "Bash" or . == "Bash(*)")' "$f" >/dev/null 2>&1; then
    die "profile $f grants blanket Bash access (\"Bash\" or \"Bash(*)\") in allow — owl requires a scoped Bash allowlist, not a blanket grant"
  fi
  if jq -e '(.permissions.allow // []) | any(. == "WebFetch" or . == "WebSearch")' "$f" >/dev/null 2>&1; then
    die "profile $f allows bare WebFetch/WebSearch — network access must be prefix-scoped, e.g. \"WebFetch(domain:example.com)\""
  fi
}
validate_profile "$SETTINGS_FILE"

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO"
git -C "$REPO" rev-parse --verify -q HEAD >/dev/null || die "repo has no commits: $REPO"

# Refuse a dirty tree: failure handling is `git reset --hard && git clean -fd`,
# which would destroy uncommitted user work. Fail loudly instead.
if [[ -n "$(git -C "$REPO" status --porcelain -- ':(exclude).owl' ':(exclude).plans')" ]]; then
  die "working tree at $REPO is dirty — commit or stash before a owl run (failed iterations are rolled back with reset --hard)"
fi

# ---------------------------------------------------------------- run setup
SLUG="$(printf '%s' "$OBJECTIVE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' \
        | sed -E 's/-+/-/g; s/^-+//; s/-+$//' | cut -c1-40 | sed -E 's/-+$//')"
[[ -n "$SLUG" ]] || SLUG="objective"
BRANCH="owl/$SLUG"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$SLUG"
RUN_DIR="$REPO/.owl/$RUN_ID"
NOTES_FILE="$REPO/.owl/notes-$SLUG.md"
LOCK_DIR="$REPO/.owl/lock"
mkdir -p "$RUN_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  die "another owl run holds the lock at $LOCK_DIR (remove it if stale)"
fi
cleanup() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

LOG="$RUN_DIR/log"
exec > >(tee -a "$LOG") 2>&1
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

START_EPOCH="$(date +%s)"
MAX_SECONDS="${OWL_MAX_SECONDS:-$((MAX_MINUTES * 60))}"
DEADLINE=$((START_EPOCH + MAX_SECONDS))

log "owl run $RUN_ID"
log "objective: $OBJECTIVE"
[[ -n "$STOP_WHEN" ]] && log "stop-when: $STOP_WHEN"
log "repo: $REPO | branch: $BRANCH | caps: $MAX_ITERATIONS iterations, ${MAX_SECONDS}s wall clock"
log "claude: $CLAUDE_BIN | settings: $SETTINGS_FILE | permission-mode: dontAsk (no bypass flags) | profile: $PROFILE"

# Keep the machine awake for the duration of this process (macOS).
if [[ "$(uname)" == "Darwin" && "${OWL_NO_CAFFEINATE:-0}" != "1" ]] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dims -w $$ &
  log "caffeinate engaged (pid $!)"
fi

# Branch: create owl/<slug> or reuse it if it already exists.
if git -C "$REPO" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null; then
  git -C "$REPO" checkout -q "$BRANCH" || die "could not checkout existing branch $BRANCH"
  log "reusing existing branch $BRANCH"
else
  git -C "$REPO" checkout -q -b "$BRANCH" || die "could not create branch $BRANCH"
  log "created branch $BRANCH"
fi

if [[ ! -f "$NOTES_FILE" ]]; then
  {
    printf '# owl notes — %s\n' "$SLUG"
    printf '(orchestrator-owned; the agent reads this file and must never write it)\n'
  } > "$NOTES_FILE"
fi

META="$RUN_DIR/run-meta.json"
jq -n \
  --arg objective "$OBJECTIVE" --arg stop_when "$STOP_WHEN" --arg repo "$REPO" \
  --arg branch "$BRANCH" --arg run_id "$RUN_ID" \
  --argjson max_iterations "$MAX_ITERATIONS" --argjson max_seconds "$MAX_SECONDS" \
  --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg profile "$PROFILE" --arg settings_file "$SETTINGS_FILE" \
  '{objective: $objective, stop_when: $stop_when, repo: $repo, branch: $branch,
    run_id: $run_id, max_iterations: $max_iterations, max_seconds: $max_seconds,
    started_at: $started_at, profile: $profile, settings_file: $settings_file}' > "$META"

ITERATIONS_JSONL="$RUN_DIR/iterations.jsonl"
: > "$ITERATIONS_JSONL"

# Decision journal (never-halt contract). Created lazily on the first
# journaled decision so its absence means "no provisional decisions made".
DECISIONS_JSONL="$RUN_DIR/decisions.jsonl"

# ---------------------------------------------------------------- helpers
build_prompt() { # $1=file $2=iteration
  {
    printf '%s\n' 'You are one iteration of an unattended overnight coding loop ("owl"). No human is present; never ask questions.'
    printf 'This is iteration %s of at most %s.\n\n' "$2" "$MAX_ITERATIONS"
    printf 'OBJECTIVE:\n%s\n\n' "$OBJECTIVE"
    if [[ -n "$STOP_WHEN" ]]; then
      printf 'STOP CONDITION (set should_fully_stop=true ONLY if this is fully met and verified):\n%s\n\n' "$STOP_WHEN"
    fi
    printf 'FIRST: read the loop notes file at %s — it is READ-ONLY for you (orchestrator-owned) and holds learnings from earlier iterations. Do not repeat recorded mistakes.\n\n' "$NOTES_FILE"
    printf '%s\n' 'THEN: pick the NEXT SMALLEST VERIFIABLE unit of work toward the objective and do only that:'
    printf '%s\n' '- Small: one test, one function, one file — something reviewable in a single commit.'
    printf '%s\n' '- Verifiable: run the check that proves it (tests, build, lint). If the check fails and you cannot fix it this iteration, report success=false.'
    printf '%s\n\n' '- Leave the tree in the state you want committed; do not create scratch files you do not clean up.'
    printf '%s\n' 'HARD RULES:'
    printf '%s\n' '- NO git commits, pushes, resets, checkouts, merges, or stashes. The orchestrator owns git entirely.'
    printf '%s\n' '- Never touch the .owl/ or .plans/ directories.'
    printf '%s\n\n' '- If you changed nothing, you MUST report success=false (a no-op is a failed iteration).'
    printf '%s\n' 'MAJOR DECISIONS — NEVER-HALT CONTRACT (nobody is awake to ask):'
    printf '%s\n' '- If you hit a major decision you cannot settle (ambiguous requirement, competing designs, missing convention), you MUST NOT stop, stall, or wait. Pick a defensible provisional path and keep working.'
    printf '%s\n' '- Prefer the most reversible defensible option, and report EVERY such call in the provisional_decisions field of your output (empty array if none). A human reviews each one in the morning and may pivot it.'
    printf '%s\n\n' '- HARD LIMIT: destructive, irreversible, or security-sensitive actions remain forbidden no matter what — provisional autonomy NEVER overrides the permission sandbox or these rules. If every option would need one, do the safe subset and record that as the provisional choice.'
    printf '%s\n' 'OUTPUT CONTRACT: your FINAL message must be EXACTLY one JSON object — no prose, no code fences:'
    printf '%s\n' '{"success": <bool>, "summary": "<what this iteration did, <=72 chars>", "key_changes": ["<files/behaviour changed>"], "key_learnings": ["<durable learnings for the notes file>"], "provisional_decisions": [{"decision_needed": "<the call you could not settle>", "options_considered": ["<option>"], "provisional_choice": "<path taken>", "rationale": "<why defensible>", "reversibility": "easy|moderate|hard"}], "should_fully_stop": <bool>}'
  } > "$1"
}

run_claude() { # $1=prompt_file $2=raw_out; respects DEADLINE; 124 on timeout
  (
    cd "$REPO" || exit 127
    exec "$CLAUDE_BIN" -p \
      --output-format json \
      --permission-mode dontAsk \
      --setting-sources project \
      --settings "$SETTINGS_FILE" \
      --disallowedTools \
        "Bash(git commit*)" "Bash(git push*)" "Bash(git reset*)" \
        "Bash(git checkout*)" "Bash(git rebase*)" "Bash(git merge*)" \
        "Bash(git clean*)" "Bash(git add*)" "Bash(git stash*)" \
      < "$1" > "$2" 2>> "$RUN_DIR/claude-stderr.log"
  ) &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if (( $(date +%s) >= DEADLINE )); then
      log "wall-clock cap hit mid-iteration — killing claude (pid $pid)"
      kill -TERM "$pid" 2>/dev/null
      sleep 1
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
  done
  wait "$pid"
}

tree_dirty() { # 0 if there are uncommitted changes outside .owl/.plans
  [[ -n "$(git -C "$REPO" status --porcelain -- ':(exclude).owl' ':(exclude).plans')" ]]
}

rollback() {
  git -C "$REPO" reset --hard -q HEAD
  git -C "$REPO" clean -fdq -e .owl -e .plans
}

append_notes() { # $1=iter $2=outcome $3=summary $4=learnings(jsonarr) $5=reason $6=decisions(jsonarr, annotated)
  {
    printf '\n## %s iteration %s — %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
    [[ -n "$5" ]] && printf 'reason: %s\n' "$5"
    [[ -n "$3" ]] && printf 'summary: %s\n' "$3"
    if [[ "$4" != "[]" && -n "$4" ]]; then
      printf 'learnings:\n'
      printf '%s' "$4" | jq -r '.[] | "- " + tostring'
    fi
    if [[ "$6" != "[]" && -n "$6" ]]; then
      printf 'provisional decisions (never-halt — stay consistent with these unless the notes say a human pivoted):\n'
      printf '%s' "$6" | jq -r '.[] | "- " + .id + ": " + .decision_needed + " -> chose: " + .provisional_choice + " (" + .rationale + ") [reversibility: " + .reversibility + "]"'
    fi
  } >> "$NOTES_FILE"
}

record_iteration() { # $1=iter $2=status $3=reason $4=commit $5=summary $6=changes $7=learnings $8=stop $9=cost $10=decision_ids(jsonarr)
  jq -cn \
    --argjson n "$1" --arg status "$2" --arg reason "$3" --arg commit "$4" \
    --arg summary "$5" --argjson key_changes "$6" --argjson key_learnings "$7" \
    --argjson stop_claimed "$8" --argjson cost_usd "$9" --argjson decision_ids "${10}" \
    '{n: $n, status: $status, reason: $reason, commit: $commit, summary: $summary,
      key_changes: $key_changes, key_learnings: $key_learnings,
      stop_claimed: $stop_claimed, cost_usd: $cost_usd, decision_ids: $decision_ids}' >> "$ITERATIONS_JSONL"
}

journal_decisions() { # $1=iter $2=provisional_decisions(jsonarr)
  # Annotates each decision with a run-scoped id (D-<n>) and the iteration,
  # normalizes the schema, appends one JSON line per decision to
  # $DECISIONS_JSONL, and advances DECISION_COUNT. Sets ANNOTATED_DECISIONS.
  ANNOTATED_DECISIONS="$(printf '%s' "$2" | jq -c --argjson iter "$1" --argjson base "$DECISION_COUNT" '
    to_entries | map({
      id: ("D-" + (($base + .key + 1) | tostring)),
      iteration: $iter,
      decision_needed: ((.value.decision_needed // "") | tostring),
      options_considered: ((.value.options_considered // []) | if type == "array" then map(tostring) else [tostring] end),
      provisional_choice: ((.value.provisional_choice // "") | tostring),
      rationale: ((.value.rationale // "") | tostring),
      reversibility: ((.value.reversibility // "unknown") | tostring)})')"
  printf '%s' "$ANNOTATED_DECISIONS" | jq -c '.[]' >> "$DECISIONS_JSONL"
  DECISION_COUNT=$((DECISION_COUNT + $(printf '%s' "$ANNOTATED_DECISIONS" | jq 'length')))
}

# ---------------------------------------------------------------- main loop
CONSECUTIVE_FAILURES=0
COMMITS_MADE=0
DECISION_COUNT=0
HALT_REASON=""
ITER=0

while :; do
  if (( ITER >= MAX_ITERATIONS )); then HALT_REASON="iteration cap reached ($MAX_ITERATIONS)"; break; fi
  if (( $(date +%s) >= DEADLINE ));  then HALT_REASON="wall-clock cap reached (${MAX_SECONDS}s)"; break; fi
  if (( CONSECUTIVE_FAILURES >= 3 )); then HALT_REASON="kill switch: 3 consecutive failed iterations"; break; fi

  ITER=$((ITER + 1))
  log "--- iteration $ITER/$MAX_ITERATIONS (consecutive failures: $CONSECUTIVE_FAILURES) ---"

  PROMPT_FILE="$RUN_DIR/prompt-$ITER.txt"
  RAW_OUT="$RUN_DIR/iter-$ITER.raw.json"
  build_prompt "$PROMPT_FILE" "$ITER"

  run_claude "$PROMPT_FILE" "$RAW_OUT"
  CLAUDE_EXIT=$?

  STATUS="failure" REASON="" COMMIT="" SUMMARY="" STOP_CLAIMED=false
  CHANGES="[]" LEARNINGS="[]" PROV="[]" ANNOTATED_DECISIONS="[]" COST=0

  if [[ "$CLAUDE_EXIT" -eq 124 ]]; then
    REASON="killed at wall-clock cap"
  elif [[ "$CLAUDE_EXIT" -ne 0 ]]; then
    REASON="claude exited $CLAUDE_EXIT (see claude-stderr.log)"
  else
    COST="$(jq -r '.total_cost_usd // 0' "$RAW_OUT" 2>/dev/null || printf '0')"
    RESULT_TEXT="$(jq -r '.result // empty' "$RAW_OUT" 2>/dev/null || true)"
    # Strip optional ```json fences, then require the strict contract.
    INNER="$(printf '%s' "$RESULT_TEXT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' | jq -c '
      if (type == "object") and (has("success")) and (has("summary")) and (has("should_fully_stop"))
      then . else error("missing contract fields") end' 2>/dev/null || true)"
    if [[ -z "$RESULT_TEXT" ]]; then
      REASON="empty result from claude (contract violation)"
    elif [[ -z "$INNER" ]]; then
      REASON="output violates the JSON contract (not parseable / missing fields)"
      log "contract violation; raw result head: $(printf '%s' "$RESULT_TEXT" | head -c 200)"
    else
      SUMMARY="$(printf '%s' "$INNER" | jq -r '.summary // "" | tostring' | tr '\n' ' ' | cut -c1-72 | sed -E 's/[[:space:]]+$//')"
      CHANGES="$(printf '%s' "$INNER" | jq -c '.key_changes // [] | if type=="array" then . else [tostring] end')"
      LEARNINGS="$(printf '%s' "$INNER" | jq -c '.key_learnings // [] | if type=="array" then . else [tostring] end')"
      PROV="$(printf '%s' "$INNER" | jq -c '.provisional_decisions // [] | if type=="array" then . else [] end')"
      STOP_CLAIMED="$(printf '%s' "$INNER" | jq -r 'if .should_fully_stop == true then "true" else "false" end')"
      AGENT_SUCCESS="$(printf '%s' "$INNER" | jq -r 'if .success == true then "true" else "false" end')"
      if [[ "$AGENT_SUCCESS" != "true" ]]; then
        REASON="agent reported success=false"
      elif ! tree_dirty; then
        REASON="no-op: agent claimed success but the diff is empty (halt rule: counts as failure)"
      else
        STATUS="success"
      fi
    fi
  fi

  NDEC="$(printf '%s' "$PROV" | jq 'length' 2>/dev/null || printf '0')"

  if [[ "$STATUS" == "success" ]]; then
    # Compute the [PROVISIONAL D-n] tag first so the commit message carries the
    # ids; the journal entries are written only once the commit lands.
    PROVISIONAL_TAG=""
    if (( NDEC > 0 )); then
      IDS=""
      for ((i = 1; i <= NDEC; i++)); do IDS="${IDS:+$IDS }D-$((DECISION_COUNT + i))"; done
      PROVISIONAL_TAG=" [PROVISIONAL $IDS]"
    fi
    git -C "$REPO" add -A -- ':(exclude).owl' ':(exclude).plans'
    if git -C "$REPO" commit -qm "owl $ITER: $SUMMARY$PROVISIONAL_TAG"; then
      COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
      COMMITS_MADE=$((COMMITS_MADE + 1))
      CONSECUTIVE_FAILURES=0
      if (( NDEC > 0 )); then
        journal_decisions "$ITER" "$PROV"
        log "iteration $ITER journaled $NDEC provisional decision(s) (never-halt): $IDS"
      fi
      log "iteration $ITER SUCCESS — committed $COMMIT: $SUMMARY$PROVISIONAL_TAG (cost \$${COST})"
    else
      STATUS="failure"
      REASON="git commit failed despite non-empty diff"
      rollback
      CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
      log "iteration $ITER FAILURE — $REASON"
    fi
  else
    rollback
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    log "iteration $ITER FAILURE — $REASON (rolled back; cost \$${COST})"
    if (( NDEC > 0 )); then
      log "iteration $ITER reported $NDEC provisional decision(s) — dropped with the rollback (failed work is not journaled)"
    fi
  fi

  OUTCOME="SUCCESS"; [[ "$STATUS" == "failure" ]] && OUTCOME="FAILURE"
  append_notes "$ITER" "$OUTCOME" "$SUMMARY" "$LEARNINGS" "$REASON" "$ANNOTATED_DECISIONS"
  record_iteration "$ITER" "$STATUS" "$REASON" "$COMMIT" "$SUMMARY" "$CHANGES" "$LEARNINGS" "$STOP_CLAIMED" "$COST" \
    "$(printf '%s' "$ANNOTATED_DECISIONS" | jq -c 'map(.id)')"

  if [[ "$STOP_CLAIMED" == "true" && "$STATUS" == "success" ]]; then
    HALT_REASON="agent claimed the stop condition is met — UNVERIFIED, review required"
    log "agent set should_fully_stop=true. Treating the claim as UNVERIFIED and halting."
    break
  fi
done

log "loop halted: $HALT_REASON"
log "iterations run: $ITER | commits made: $COMMITS_MADE | provisional decisions journaled: $DECISION_COUNT"

jq --arg halt_reason "$HALT_REASON" \
   --arg ended_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   --argjson iterations_run "$ITER" --argjson commits_made "$COMMITS_MADE" \
   --argjson decisions_made "$DECISION_COUNT" \
   '. + {halt_reason: $halt_reason, ended_at: $ended_at,
         iterations_run: $iterations_run, commits_made: $commits_made,
         decisions_made: $decisions_made}' \
   "$META" > "$META.tmp" && mv "$META.tmp" "$META"

# ---------------------------------------------------------------- morning review
ARTIFACT="$("$SCRIPT_DIR/morning-review.sh" "$RUN_DIR")" || die "morning review generation failed"
log "morning review artifact: $ARTIFACT"

if command -v curator >/dev/null 2>&1; then
  log "next_step: curator open $ARTIFACT"
else
  log "next_step: open $ARTIFACT in a browser (curator not on PATH)"
fi
exit 0
