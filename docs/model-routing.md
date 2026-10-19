# Model routing and escalate-on-block (recommend-only)

`engine/routing/routing.json` + `engine/routing/routing.mjs` give the engine a
committed, validated notion of model tiers and one convention for what to do
when a stage or gate blocks: consult a STRONG-tier advisor, never let it
answer.

## Tiers

Three tiers, matching the model-selection doctrine (STRONG plans/architects/
advises, FAST executes code + commits, LIGHT does mechanical sweeps) and
keyed identically to `DEFAULT_RATES` in `engine/bench/bench.mjs`, so a
consult against any tier model is always priceable:

| Tier | Models (MVP) | Role |
| --- | --- | --- |
| `strong` | `fable`, `opus` | explore, plan, architect, tricky debugging, advisor judgment |
| `fast` | `sonnet` | code + commit execution once a plan is settled |
| `light` | `haiku` | mechanical sweeps (renames, codemods, formatting) |

The **advisor pass** in this doctrine — run a STRONG-tier subagent over a
plan (context, approach, risks) before implementing a new change-set — is
exactly the same doctrine `engine advisor consult` gives a CLI seam to when a
run is *already blocked* rather than pre-implementation.

## Escalate-on-block

`escalation.on_block: "consult-strong-advisor"` names the convention: when a
stage or gate blocks and an agent judges it worth a second opinion, it runs
`engine advisor consult --run <id> --trigger <gate-id|stage|free-text>
[--model fable]`. That verb:

1. refuses (exit 2) if `--model` is not in the `strong` tier,
2. refuses (exit 2) if any of `--apply` / `--answer` / `--unblock` is passed,
3. appends exactly one `advisor_consult` event to the run's `events.jsonl`,
4. creates `<run>/advisor/` for the human-readable recommendation the calling
   agent is expected to write there afterward.

It is a **convention plus a CLI verb, not automation** — nothing fires it on
your behalf. There is deliberately no `stage_blocked`-triggered hook here
(see `engine/routing/README.md`'s "Not a hook, not automation" section); that
would need the full kill-switch + `CLAUDE_JOB_DIR` + `OWL_RUN` self-disable
treatment this design sidesteps entirely by staying manual.

## The two kinds of "blocked" — this split matters

**Human-gate block** (`engine/stages/CONTRACT.md`'s intent gate, or any
pending decision in `decisions.json`): the advisor may help *draft what to
present* to the human, but the human still answers. **Always escalate to the
human, never let the advisor auto-answer.** This is the doctrine's single
hardest line — see "Doctrine bleed" below.

**Technical block** (a failing check, an ambiguous implementation choice, a
stuck recheck loop): the advisor recommends an unblock path, and the agent
applies that recommendation itself, through the normal stage machinery — the
advisor's note is input to the agent's next step, not a bypass of any stage
gate.

`engine advisor consult` does not know which kind of block it was called for
— `--trigger` is free text precisely so the calling agent states it, and the
doctrine above is what the agent is expected to have read before deciding to
consult at all.

## Recommend-only is a schema invariant

`escalation.authority` must be the literal string `"recommend-only"`.
`engine/routing/routing.mjs`'s `loadRoutingConfig()` throws on any other
value — including the field being absent — so this cannot be flipped by
editing one string in isolation. Promoting to any form of auto-apply
requires:

- a new schema version (`detent-routing-v2` or later), and
- a human review of the promotion criterion below.

This is deliberate friction. See `engine/routing/routing.json`'s
`escalation.promotion` field for the current criterion:

```json
"promotion": {
  "requires": "paired cost+quality ledger lines (bench advisor_consults + eval verdicts)",
  "min_paired_ledger_lines": 10
}
```

i.e.: at least 10 `benchmarks/ledger.jsonl` lines where an `advisor_consult`
happened, each pairable against an `engine eval` verdict line for the same
window, before anyone even proposes loosening `authority`. Mirrors the
pattern `engine eval`'s own gate uses (advisory → blocking after a burn-in of
green baselines) — see `engine/eval/README.md`'s "Gate promotion & burn-in".

## Why authority is frozen, and why the guard is a seam, not a sandbox

The single most likely misuse of this feature is an advisor's "recommendation"
getting treated as a human gate's answer. Nothing here prevents an agent from
writing directly to `decisions.json` through an ordinary tool call — that is
not what `engine advisor consult` defends against. What it does is:

- the CLI refuses to run a consult with `--apply`/`--answer`/`--unblock`,
- the consult writes only under `<run>/advisor/`, never `decisions.json` or
  `stage-status.json` (regression-tested in
  `engine/cli/tests/advisor.test.mjs`, which asserts both files are
  byte-identical across a consult),
- the doctrine itself says "agents never answer a gate."

Three independent tripwires — CLI guard, schema invariant, doctrine — **not**
a sandbox. Say this plainly rather than implying containment: a
rogue/confused agent that decides to ignore all three can still mutate
`decisions.json` directly. Defense in depth, not a lock.

## The cost half of the pair — honestly degraded today

An `advisor_consult` event proves the consult *happened*; it carries no cost
figure. `engine/bench/bench.mjs`'s `computeOtherMetrics()` counts these
events (`advisor_consults`, or `{recorded:false}` when none exist — the same
`autofix_rounds` honesty idiom), and `ledgerLine()` carries an additive
`advisor_consults: <count>` field into `benchmarks/ledger.jsonl`.

The **quality** half of the promotion pairing (an `engine eval` verdict for
the same window) is answerable today. The **cost** half is not, in general:
there is no transcript telemetry (the same gap the live-view MVP documents in
`engine/cli/README.md`), so most consults will land in the ledger with a
count but no matching `{phase:"advisor", ...}` row in `tokens.jsonl`. If the
calling agent's advisor token usage happens to be genuinely known, it appends
that row itself, and `computeTokens()`'s existing `by_phase` bucketing in
`engine/bench/bench.mjs` picks it up with zero code change on this feature's
part.

**Do not "fix" this by estimating advisor tokens.** The pairing question —
"does escalate-on-block pay off?" — is only answerable, today, for the subset
of runs where the agent recorded advisor tokens. Two ledger recipes for
asking it anyway, restricted to that honest subset:

```sh
# Effective agentic time on runs that consulted an advisor vs runs that didn't
# (bench lines only — the schema key absent distinguishes them from eval lines).
jq -c 'select(.schema == null and .advisor_consults > 0) | .effective_agentic_time_ms' benchmarks/ledger.jsonl
jq -c 'select(.schema == null and .advisor_consults == 0) | .effective_agentic_time_ms' benchmarks/ledger.jsonl

# Cost delta, restricted to runs where tokens were actually recorded (never
# estimate the rest):
jq -c 'select(.schema == null and .advisor_consults > 0 and .tokens.recorded) | .tokens.estimated_cost_usd' benchmarks/ledger.jsonl
```

## Config drift across three surfaces

Tiers exist in three places: `engine/routing/routing.json`, `DEFAULT_RATES`
in `engine/bench/bench.mjs`, and this file's prose (the plugin's own
model-selection guidance). Only the first two are
mechanically checked — `engine/routing/test/routing.test.mjs` asserts every
model named in `routing.json`'s tiers has a `DEFAULT_RATES` row, so routing
and pricing cannot silently drift apart. This file's prose is intentionally
unenforced: it documents guidance, not a repo invariant.

## See also

- `engine/routing/README.md` — the engine-side (company-neutral) contract.
- `docs/benchmarking.md` / `benchmarks/README.md` — the `advisor_consults`
  ledger field and jq recipes above.
- `engine/eval/README.md` — the gate promotion/burn-in pattern this feature's
  promotion criterion mirrors.
