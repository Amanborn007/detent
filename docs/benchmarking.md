# Benchmarking a run

Every engine run can be measured. The benchmark harness reads a run's event log
and turns it into per-phase timings, wait-time breakdowns, token/model/cost
accounting, and one headline number: **effective agentic time**.

**Takeaway:** wall-clock lies. A run that took 3 hours may have spent 2h50m
waiting on a human gate or CI. Effective agentic time is the part where the
agent was the thing making progress.

## What gets measured

**Per-phase wall-clock.** For each stage, `stage_end − stage_begin`. Derived
from the transition events the engine already appends to `events.jsonl` — the
stage skills are not touched.

**Human-gate wait.** Time a gate sat open waiting for a person.
`Σ (gate_answered_ts − gate_opened_ts)` across gates, paired by `decision_id`.
The engine emits `gate_opened` at gate-open and `gate_answered` the moment it
observes a human's answer (it never writes the answer itself).

**Async-external wait.** Time blocked on things outside the run — PENDING-EXTERNAL
sign-offs, CI, bot comments. `Σ (external_response_ts − external_request_ts)`,
paired by `id`, grouped by `kind`. Summed from whatever `external_request` /
`external_response` events are present.

**Effective agentic time** — the headline:

```
effective_agentic_time = wall_clock − human_gate_wait − async_external_wait
```

And `human_touch_ratio = human_gate_wait / wall_clock`.

**Tokens, models, cost — best-effort.** Read from `tokens.jsonl`
(`{phase, model, input, output}` per line). Cost is estimated from an editable
per-model rate table (USD per 1e6 tokens). If `tokens.jsonl` is absent the
benchmark says `tokens: { recorded: false }` — it is **never fabricated**. A
model with no rate row is left unpriced and surfaced in `unpriced_models`.

**Other metrics** — counted from their event types: `gates`, `autofix_rounds`,
`findings_by_severity`, `commits`, `api_drops`, `resumes`, `advisor_consults`,
plus pass/fail per phase from `stage-status.json`. A category with no events
is reported `{ recorded: false }` so a real zero is never confused with
"unrecorded".

## The event contract

The engine emits today: `run_created`, `stage_begin`, `stage_end`,
`gate_raised`, `gate_opened`, `gate_answered`, `stage_blocked`.

To enrich a benchmark, emit these from the relevant stage (bench sums whatever
it finds):

| Event | Fields | Feeds |
| --- | --- | --- |
| `external_request` / `external_response` | `id`, `kind` (`sign_off`\|`ci`\|`bot_comment`\|…) | async-external wait |
| `finding` | `severity` | findings by severity |
| `commit` | — | commit count |
| `autofix_round` / `recheck_round` | — | auto-fix rounds |
| `api_drop`, `resume` / `run_resumed` | — | drop/resume count |
| `advisor_consult` | `model`, `tier`, `trigger`, `decision_id`, `authority` | advisor consult count (see [`docs/model-routing.md`](model-routing.md)) |

## Where it's stored

| File | Location | Committed |
| --- | --- | --- |
| `benchmark.json` (rich, per run) | `<DETENT_ROOT>/.sdlc/<run-id>/benchmark.json` | No — `.sdlc/` is gitignored |
| `ledger.jsonl` (one line per run) | `benchmarks/ledger.jsonl` | **Yes** — the durable in-repo record |

Full ledger-line schema and read recipes: [`benchmarks/README.md`](../benchmarks/README.md).

## Eval lines share the same ledger

`engine eval` (the offline eval harness — [`engine/eval/README.md`](../engine/eval/README.md))
appends its own lines to `benchmarks/ledger.jsonl` too, one per scoring run,
tagged `"schema": "detent-eval-v1"` so any reader can tell them apart from
bench's schema-less lines. An eval line carries `verdict`
(`UPGRADE`\|`NEUTRAL`\|`DEGRADE`), the per-suite `score`/`baseline`/`delta`,
`deterministic_flips`, and `judge: { recorded }` (mirroring bench's own
`tokens: { recorded: false }` honesty rule — no judge-graded case run ⇒
`recorded: false`, never a fabricated score). The **verdict authority is the
committed `evals/baseline.json`**, not this ledger — the ledger is a trend
record only. See `benchmarks/README.md`'s "Eval lines in the ledger" section
for the full field list.

Because both kinds of lines share the one ledger, "does escalate-on-block pay
off?" (see [`docs/model-routing.md`](model-routing.md)) is a single jq query
pairing a bench line's `advisor_consults` count against the nearest eval
verdict:

```sh
jq -c -s '
  [.[] | select(.schema == null)] as $bench |
  [.[] | select(.schema == "detent-eval-v1")] as $evals |
  { with_consults: ($bench | map(select(.advisor_consults > 0)) | length),
    without_consults: ($bench | map(select(.advisor_consults == 0)) | length),
    eval_verdicts: ($evals | map(.verdict) | group_by(.) | map({(.[0]): length}) | add) }
' benchmarks/ledger.jsonl
```

Restrict to runs with real cost data before trusting a cost delta (see
`docs/model-routing.md`'s "cost half of the pair" section — never estimate
advisor tokens).

## How to run it

```sh
# via the engine CLI (also: detent bench <run-id>)
engine bench <run-id>

# override the rate table for one invocation
engine bench <run-id> --rates my-rates.json

# directly, against any run directory
node engine/bench/bench.mjs <DETENT_ROOT>/.sdlc/<run-id>
```

Each run writes `benchmark.json` and appends one line to
`benchmarks/ledger.jsonl`. Re-running appends again (the ledger is a log, not a
snapshot).

### Rate table

`DEFAULT_RATES` in `engine/bench/bench.mjs` (USD per 1e6 tokens, input/output),
keyed by the `model` string in `tokens.jsonl`. Edit it to match current pricing,
or pass `--rates <json-file>` with the same shape.

## Tests

- `engine/bench/test/` — unit tests for every metric against a fixture with
  round-number timestamps (phase timing, gate/async subtraction, the
  effective-agentic-time identity, "tokens unrecorded" honesty).
- `engine/cli/tests/bench.test.mjs` — end-to-end: the CLI emits the gate timing
  events and `engine bench` writes both artifacts.

```sh
node --test engine/bench/test/ engine/cli/tests/
```
