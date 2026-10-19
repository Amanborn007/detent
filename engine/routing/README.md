# routing — model-tier routing + escalate-on-block (recommend-only)

Company-neutral, like the rest of `engine/` (this tree syncs to the
standalone public repo; `engine/scripts/company-strings-check.sh` runs
against it on push — no company names or internal hostnames here).

## What this is

`engine/routing/routing.json` is a committed config that:

1. Groups model names into tiers (`strong` / `fast` / `light`, mirroring the
   STRONG/FAST/LIGHT model-selection doctrine — see `docs/model-routing.md`).
   Tier keys and their model names line up 1:1 with the keys of `DEFAULT_RATES`
   in `engine/bench/bench.mjs`, so every consult this module knows about is
   priceable.
2. Declares the escalate-on-block convention: `escalation.on_block` names the
   behavior (`"consult-strong-advisor"`); `escalation.authority` is a schema
   invariant pinned to the literal string `"recommend-only"`.

`engine/routing/routing.mjs` loads and validates that file. It is a pure,
zero-dependency module — same idiom as `engine/self-feedback/feedback.mjs` —
with no file-writing side effects of its own.

## Not a hook, not automation

There is deliberately no hook here. Escalate-on-block is a convention plus a
CLI verb (`engine advisor consult`, in `engine/cli/engine.mjs`) that an agent
calls explicitly when it judges a block worth a STRONG-tier second opinion.
Nothing fires it automatically. This keeps the whole kill-switch /
`CLAUDE_JOB_DIR` / `OWL_RUN` self-disable surface out of scope — there is
nothing here that could accidentally spawn work unattended. A
`stage_blocked`-triggered nudge hook is an explicit, tracked deferral (would
need the full kill-switch treatment before it could exist).

## Recommend-only is enforced at the seam, not by sandboxing

`engine advisor consult`:
- refuses (exit 2) if `--model` is not in the `strong` tier,
- refuses (exit 2) if any of `--apply` / `--answer` / `--unblock` is passed,
- writes nothing under the run except one `advisor_consult` event in
  `events.jsonl` and a `<run>/advisor/` directory for the human-readable
  recommendation the calling agent is expected to produce afterward.

It never touches `decisions.json` or `stage-status.json`. That is
defense-in-depth, not containment: a confused or rogue agent can still write
those files directly through ordinary tool calls. The doctrine
("agents never answer a gate") plus this CLI guard plus the schema invariant
above are three independent tripwires, not a sandbox — see
`docs/model-routing.md` for the full doctrine writeup, and
`engine/cli/tests/advisor.test.mjs` for the regression test that pins
`decisions.json` / `stage-status.json` byte-identical across a consult.

## Promotion

`authority` cannot become anything other than `"recommend-only"` without a new
schema version (`detent-routing-v2` or later) and a human review — see
`escalation.promotion` in `routing.json` and the "why authority is frozen"
section of `docs/model-routing.md`. Nobody can flip this by editing one
string; `engine/routing/test/routing.test.mjs` asserts the guard throws for
any other value, including the field's absence.

## Cost is never fabricated

An `advisor_consult` event proves the consult happened. It carries no cost
figure. If the calling agent's advisor tokens are genuinely known, it appends
a `{phase:"advisor", model, input, output}` row to `<run>/tokens.jsonl` —
`engine/bench/bench.mjs`'s existing `by_phase` bucketing picks that up with
zero code change. When token usage is unknown (the common case today — there
is no transcript telemetry, per the live-view MVP notes in
`engine/cli/README.md`), the cost half of the pair is simply absent. Never
guess it.

## Tests

```sh
node --test engine/routing/test/
```
