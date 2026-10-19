# benchmarks/ — the committed run ledger

Every engine run can be benchmarked. Two artifacts come out of `engine bench <run-id>`:

| Artifact | Location | Committed? | Purpose |
| --- | --- | --- | --- |
| `benchmark.json` | `<DETENT_ROOT>/.sdlc/<run-id>/benchmark.json` | No (`.sdlc/` is gitignored) | Rich, per-run detail |
| `ledger.jsonl` | `benchmarks/ledger.jsonl` (here) | **Yes** | One line per benchmark run, tracked in git |

The rich `benchmark.json` lives with the run state and is disposable. The
**ledger is the durable, in-repo record** — one JSON object per line, appended
(never rewritten), so run cost/time trends survive across machines and clones.

## The headline metric: effective agentic time

The point of the harness is to separate *the agent making progress* from
*everything else the clock was doing*. Two kinds of waiting are factored out:

- **human-gate wait** — a gate sat open waiting for a human to answer it.
- **async-external wait** — waiting on things outside the run: PENDING-EXTERNAL
  sign-offs, CI, bot comments.

```
effective_agentic_time = wall_clock − human_gate_wait − async_external_wait
```

Plus `human_touch_ratio = human_gate_wait / wall_clock` — how much of the
elapsed time was blocked on a human.

## How each number is derived

All timings come from the run's append-only `events.jsonl` (the engine appends
one line per stage/gate transition — deleting it breaks nothing else):

| Metric | Derived from |
| --- | --- |
| per-phase wall-clock | `stage_end.ts − stage_begin.ts` per stage |
| total wall-clock | first event ts → last event ts |
| human-gate wait | Σ (`gate_answered_ts − gate_opened_ts`) over gates, paired by `decision_id` |
| async-external wait | Σ (`external_response_ts − external_request_ts`), paired by `id`, grouped by `kind` |
| tokens / models / cost | `tokens.jsonl` rows `{phase, model, input, output}`, priced via the rate table |
| gates / auto-fix rounds / findings / commits / api-drops | counted from their event types |

### Event types

Emitted by the engine today: `run_created`, `stage_begin`, `stage_end`,
`gate_raised`, `gate_opened`, `gate_answered`, `stage_blocked`.

Consumed if present (define + emit them from the relevant stage to enrich the
benchmark — bench sums whatever it finds, and never fabricates the rest):

- `external_request` / `external_response` — `{id, kind}`; `kind` ∈
  `sign_off | ci | bot_comment | …`. The async-wait pair.
- `finding` — `{severity}`. Counted by severity.
- `commit`, `autofix_round` / `recheck_round`, `api_drop`, `resume` — counts.
- `advisor_consult` — `{model, tier, trigger, decision_id, authority}`.
  Counted (`advisor_consults`); emitted by `engine advisor consult` — see
  [`docs/model-routing.md`](../docs/model-routing.md).

## Honesty rule

Nothing is fabricated. If a stream is absent the harness says so:

- No `tokens.jsonl` → `tokens: { recorded: false, … }` (never a guessed count).
- A model with no rate-table row → left out of the cost estimate and listed in
  `unpriced_models`.
- A metric category with no events → `{ recorded: false, note: … }`, so a
  genuine zero is never confused with "the run didn't emit these".

## Ledger line schema

```json
{
  "ts": "ISO-8601",
  "run_id": "…",
  "ticket_ref": "…",
  "wall_clock_ms": 0,
  "human_gate_wait_ms": 0,
  "async_external_wait_ms": 0,
  "effective_agentic_time_ms": 0,
  "human_touch_ratio": 0.0,
  "phases": 0,
  "gates": 0,
  "advisor_consults": 0,
  "tokens": { "recorded": true, "input": 0, "output": 0, "models": [], "estimated_cost_usd": 0.0 }
}
```

`advisor_consults` is additive (schema-less bench lines tolerate additive
fields; older ledger lines from before this field existed simply lack it —
readers should filter on presence, not assume `0` means "no consults"). It is
the plain count of `advisor_consult` events on the run — see
[`docs/model-routing.md`](../docs/model-routing.md).

## Eval lines in the ledger

`engine eval` (see [`engine/eval/README.md`](../engine/eval/README.md))
appends its own line to this same file after every non-`--rebaseline` run —
one line per suite-scoring run, same append-only idiom, distinguished from
bench lines by a `schema` key (bench lines carry no `schema` at the line
level, so any reader can filter on its presence):

```json
{
  "schema": "detent-eval-v1",
  "ts": "ISO-8601",
  "kind": "eval",
  "git_sha": "abc1234",
  "baseline_sha": "abc1234",
  "verdict": "NEUTRAL",
  "band": 0.05,
  "suites": { "context-adherence": { "score": 1, "baseline": 1, "delta": 0 } },
  "deterministic_flips": 0,
  "judge": { "recorded": false },
  "duration_ms": 61
}
```

- `verdict` is `UPGRADE` \| `NEUTRAL` \| `DEGRADE` — advisory only; the
  ledger line records what the run computed, it never gates anything by
  itself.
- `baseline_sha` is the `git_sha` the committed `evals/baseline.json` was
  generated at — the ledger is a trend record, **the baseline file is the
  verdict authority**, not prior ledger lines.
- `judge: { recorded: false }` mirrors this file's own token-honesty rule
  above: no judge-graded case ran (or the judge tier was skipped/degraded) ⇒
  `recorded: false`, never a fabricated score folded into the line.
- `git_sha` / `baseline_sha` are `null`, never guessed, when unavailable (no
  git, or no baseline on disk).

Full verdict semantics, cost tiers, and the rebaseline procedure:
[`engine/eval/README.md`](../engine/eval/README.md).

## Reading the ledger

```sh
# All runs, most recent last:
cat benchmarks/ledger.jsonl | jq -c '{run_id, effective_agentic_time_ms, human_touch_ratio}'

# Total estimated spend across recorded runs:
jq -s '[.[] | select(.tokens.recorded) | .tokens.estimated_cost_usd] | add' benchmarks/ledger.jsonl

# Sort runs by effective agentic time:
jq -s 'sort_by(.effective_agentic_time_ms) | .[] | {run_id, effective_agentic_time_ms}' benchmarks/ledger.jsonl

# Eval lines only (schema key distinguishes them from bench lines):
jq -c 'select(.schema == "detent-eval-v1")' benchmarks/ledger.jsonl

# Bench lines only:
jq -c 'select(.schema == null)' benchmarks/ledger.jsonl

# Pair advisor_consult counts with eval verdicts — "does escalate-on-block
# pay off" (see docs/model-routing.md's cost/quality pairing section):
jq -c -s '
  [.[] | select(.schema == null)] as $bench |
  [.[] | select(.schema == "detent-eval-v1")] as $evals |
  { with_consults: ($bench | map(select(.advisor_consults > 0)) | length),
    without_consults: ($bench | map(select(.advisor_consults == 0)) | length),
    eval_verdicts: ($evals | map(.verdict) | group_by(.) | map({(.[0]): length}) | add) }
' benchmarks/ledger.jsonl
```

## Running it

```sh
engine bench <run-id>              # via the engine CLI (detent bench <run-id>)
node engine/bench/bench.mjs <run-dir> [--rates rates.json] [--detent-root DIR]
```

The rate table (`DEFAULT_RATES` in `engine/bench/bench.mjs`, USD per 1e6 tokens)
is editable; override per-invocation with `--rates <json-file>`. See
`docs/benchmarking.md` for the full walkthrough.

## `spend-ledger.jsonl` — harness-wide Claude spend over time

Written by `engine spend --record` (see `engine/spend/spend.mjs`). Distinct from
`ledger.jsonl`: that measures a single RUN, this measures the whole harness's
Claude bill, so the two never share a line.

One line per measurement. It exists because the interventions it tracks change
WHERE work runs and HOW LONG sessions live, and neither shows up in a test —
only in the next month's numbers.

Read these two first; they are what the interventions are meant to move:

| Field | Direction | Why |
|---|---|---|
| `main_cost_per_turn` | should FALL | Main-thread turns re-read the whole conversation every time. Moving conclusion-shaped work into sub-agents takes it off that meter. |
| `subagent_share` | should RISE | Same change, seen from the other side. A sub-agent turn costs a fraction of a main-thread one. |

Three fields exist purely to stop a dishonest comparison, and `compareTracking`
sets `comparable: false` if any of them moved:

- `schema` — what counts as a turn. v1 deduped per file and double-counted every
  record a resumed session copied forward; v2 dedupes scan-globally. A v1 line
  and a v2 line are not the same measurement.
- `rate_table_version` — what a token costs.
- `window_days`, plus an overlap check: two 30-day samples taken a day apart
  share 29/30 of their data, so a near-zero delta between them means nothing.

A first measurement reports `delta: null`, never a 0% delta — "nothing to
compare" and "nothing changed" are different claims. A ledger whose lines all
fail to parse is a hard error, not a fresh baseline.

**The total is a lower bound, not the invoice.** It counts what this machine
recorded, so it undercounts any usage the local transcripts do not capture.
Reconcile against the usage console rather than treating the ledger as
authoritative. Any figure you quote must be the one in the ledger, not from a
scan run separately — two scans minutes apart differ slightly as the live
session appends, and a headline nobody can reproduce is worse than none.

Duplicate resolution is worth understanding before trusting a delta: one API
message is written to the transcript several times as it streams, and only the
record carrying a `stop_reason` has the final `output_tokens`. Keeping the first
copy understates sub-agent output and makes a sub-agent turn look cheaper than
it really is. The scan keeps the most COMPLETE
record per message id, across all files.
