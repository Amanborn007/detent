# engine/cli — the SDLC engine runner (v0)

`engine.mjs` is the deterministic driver for the file-based run state defined in
[`engine/stages/CONTRACT.md`](../stages/CONTRACT.md). It enforces the stage machine,
raises and renders human gates, and dispatches socket calls declared in `stack.yaml`
(contracts in [`engine/sockets/`](../sockets/)). Zero dependencies, Node >= 18.

Design decisions it implements (from the wiring blueprint):

- **D1** — files (`stage-status.json`, artifacts, `decisions.json`) are the only
  authoritative state; every transition *additionally* appends one line to
  `events.jsonl` (consumed by curator's timeline; deleting it breaks nothing).
- **D2** — `stage begin/end` refuses illegal transitions deterministically.
- **D4** — `engine next` is the whole driver: read state, print the exact next
  command. No orchestrator prompt.
- **D7** — curator is integrated **by contract, never vendored**: `gate open`
  writes a gate-request artifact and prints `curator open`/`curator await`
  commands when a `curator` executable is on PATH, else a terminal fallback.
- **D8** — `socket call` dispatches three kinds: `exec` (argv spawn, JSON on
  stdin), `skill`, `mcp_tool`. The CLI cannot invoke skills or MCP tools — for
  those it prints a structured instruction block for the invoking agent.

## Invocation

```
node engine/cli/engine.mjs <command> [flags]
```

(or put `engine/cli/engine.mjs` on PATH as `engine`). Common flags:
`--repo <path>` (working repo, default cwd) and `--run <run-id>` (required only
when more than one run for that repo exists under the centralized `.sdlc/`).

**Centralized run state (`DETENT_ROOT`).** `.sdlc/` and `.plans/` live in the
detent clone, NOT the work repo — tasks span multiple repos, and every run
points at the one detent home. The home is `$DETENT_ROOT` when set, else the
detent clone this CLI lives in. Without `--run`, run resolution is scoped to
runs whose `run.json` records the given `--repo`; `--run <id>` resolves across
repos.

**Output contract:** every command prints exactly one JSON line to stdout, always
with a `next_step`. Exit codes: `0` ok · `1` provider/environment failure ·
`2` refusal (illegal transition, missing artifact, pending gate, contract
violation) with a structured `reason`.

## Commands

### `engine run new --ticket <ref> [--repo <path>] [--slug <slug>] [--no-worktree]`

Creates `<DETENT_ROOT>/.sdlc/<run-id>/` with `run.json`, `stage-status.json`
(all stages `pending`, current = `intake`), an empty `decisions.json`, and the
first `events.jsonl` event. `run-id` = `<YYYY-MM-DD>-<ticket-key>-<slug>` per
CONTRACT.md; run-ids are immutable — an existing dir is refused (exit 2), a
re-run is a new run. If the detent home is a git repo and `.sdlc` is not
ignored, the ignore entry is appended (CONTRACT.md requires `.sdlc/`
gitignored).

**Worktree by default.** The documented flow is worktree-based: `run new`
creates a dedicated git worktree of the work repo at `<run-dir>/worktree` on a
new branch `sdlc/<run-id>` — the run's working area, recorded in `run.json`
(`worktree`, `branch`). The worktree is disposable (recreate from the branch if
pruned); the run state is not. A work repo that is not a git repo with at least
one commit is refused loudly (exit 2) with `--no-worktree` offered as the
opt-out; a failed `git worktree add` cleans up the half-created run dir and
exits 1.

### `engine stage begin <stage>` / `engine stage end <stage>`

Stage order (plan carries the intent gate; ship bundles review → test/evidence →
docs → lint as sub-steps of one stage):

```
intake -> research -> plan ==(intent gate)==> implement -> recheck -> ship -> respond
```

`begin` refuses (exit 2, structured reason) when:
- the stage is unknown, or already `done` (re-run = new run);
- any prior stage is not `done` **or `skipped`** (illegal transition) —
  `skipped` is a distinct, honest status written only by the synthetic
  `engine respond --pr` entry point (never a fake `done`); no other command
  writes it, and `stage end` still refuses to end a `skipped` stage (it was
  never begun);
- a pending decision in `decisions.json` lists the stage in its `blocks` —
  the gate rule. The stage is marked `blocked` with `blocked_on`, and
  `next_step` points at `engine gate open <id>`.

`end` refuses (exit 2) when:
- the stage was never begun;
- the stage's required artifact (per CONTRACT.md) is missing:
  `intake → brief.md`, `research → research.md`, `plan → plan/plan.md`
  (implement/recheck/ship/respond have no contract-defined artifact in v0);
- the stage's end-gate decision is pending. v0 ships one end-gate: **intent**
  on `plan`. The first `stage end plan` lazily appends the gate decision
  (`gate: "intent"`, `blocks: ["implement"]`, status `pending`) and refuses;
  it keeps refusing until a human answers it. An `answer` of `revise` also
  refuses, telling you to loop back to plan.

The CLI **never writes an answer** into `decisions.json` — per CONTRACT.md only
a human (via curator, or hand-editing in the terminal fallback) does.

### `engine respond --pr <url|number> [--repo <path>] [--slug <slug>] [--no-worktree]`

Synthetic **standalone entry** into the `respond` stage — arms sentinel/respond
directly against an already-open PR, with no ticket, brief, or plan. Resolves
the PR via `gh pr view --json url,state,isDraft,headRefName,headRefOid,isCrossRepository,number`
and refuses (exit 2) a PR that is not `OPEN`, is a draft (respond is dormant
until the PR is marked ready), or is cross-repository (a fork PR — MVP refuses
loudly rather than half-working, since a push from this clone can never land
on the fork's branch). A `gh` spawn/parse failure is exit 1 — never proceeds on
partial data.

The run-id is `<date>-respond-<owner-repo-N>[-slug]`; run-ids are immutable
(a duplicate refuses, exit 2, same as `run new`). Every stage **before**
`respond` is written `"skipped"` — an honest, explicit non-status, **never**
a fake `"done"` — and `run.json` carries `synthetic: true`, `entry:
"respond-pr"`, and a `pr: {url, number, head_ref, head_sha}` block so
benchmarks/dashboards never mistake this for a full-pipeline run.

**Worktree** (default, `--no-worktree` opts out): unlike `run new` (a fresh
`sdlc/<run-id>` branch), this checks out the **PR's own head branch** —
`git fetch origin <headRefName>` then `git worktree add <dir> <headRefName>`
— because the run acts directly on the PR under review. A fetch or
`worktree add` failure (e.g. the branch is already checked out elsewhere)
cleans up the half-created run dir and exits 1, naming `--no-worktree` as the
remedy.

`next_step` points at `engine stage begin respond` plus
`engine/stages/respond/SKILL.md`'s standalone-entry section.

### `engine gate open <gate-id>`

`<gate-id>` is a gate name (`intent`) or a decision id (`D-003`). Writes/refreshes
the gate-request artifact `.sdlc/<run>/gates/<gate-id>.json`
(`{run_id, gate_id, stage, playbook, artifact_path, context_paths[], decision}`),
then:

- **curator on PATH** → prints the `curator open <artifact> --playbook <p>` +
  `curator await <decision-id>` commands as `next_step` (integration by
  contract; curator writes the human's answer into `decisions.json`);
- **no curator** → terminal fallback: renders the decision (question, options)
  and prints exactly how a human answers by editing `decisions.json`
  (`status:"answered"`, `answer`, `answered_by:"human"`, `answered_at`).

### `engine socket call <name> [--payload-file f] [--stack <path>]`

Reads `stack.yaml` (looked up at `<repo>/stack.yaml`, then
`<repo>/engine/stack.yaml`; see [`engine/stack.example.yaml`](../stack.example.yaml)).
Payload defaults to `{}`.

| kind | stack.yaml shape | behavior |
|---|---|---|
| `exec` | `command:` (+ `args:`, `timeout:`) | argv spawn (no shell), payload JSON on stdin, provider stdout passed through. Exit 1 from the provider is retried once with a warning, then surfaced as exit 1; exit 2 = contract violation, surfaced as exit 2. |
| `skill` | `kind: skill`, `skill: <name>` | prints a structured `instruction` block — the CLI cannot invoke skills; the invoking agent runs the skill and treats its output as the socket response. |
| `mcp_tool` | `kind: mcp_tool`, `tool: <name>` | same, for MCP tools. |

**Knowledge socket (multi-provider fan-out, per `sockets/knowledge.md`):** a
socket with `providers:` fans the payload out to every provider, tags each
result with its `provider` (source attribution), dedupes by `source` keeping the
highest confidence, filters `merge.min_confidence`, ranks by confidence, caps at
`merge.max_results`. One provider failing = a warning (stderr + `warnings[]`);
**all** providers failing = abort, exit 1. Skill/MCP providers in the list are
returned as `manual_providers` instruction blocks for the agent to run and merge.

The YAML parser is a deliberate zero-dep subset covering the shapes in
`stack.example.yaml` (nested maps, provider lists, inline flow arrays, quoted
scalars, comments). Anything fancier fails loudly with exit 2.

### `engine next`

The thin driver: prints the current stage, its entry/exit state, and the exact
next command (`stage begin`, produce-artifact, `gate open`, or `stage end`).
Loop on it; stop at gates. That is the whole orchestrator.

### `engine dashboard`

The run-status dashboard: assembles EVERY run under the centralized
`<DETENT_ROOT>/.sdlc/` — per run: current stage, status, `blocked_on`, pending
gates (id, question, blocked stages), age — into one JSON line (`runs[]`) and
one self-contained curator artifact at `<DETENT_ROOT>/.plans/engine-dashboard.html`
(inline CSS, system fonts, light+dark, no external URLs; decision questions are
HTML-escaped — they are untrusted text). `next_step` is the curator open
command (`engine/curator/cli.mjs open ...` when the curator is present, else
`curator open` from PATH, else a plain-browser fallback). Exit 0 with
`runs: []` when no runs exist. See `engine/stages/dashboard/README.md`.

### `engine live <run-id>` — see "Live view" below

Per-run streaming counterpart to `engine dashboard`: one run's coalesced
checklist + streamed answer, incrementally updated. Full contract in the
"Live view (`engine step` + `engine live`)" section below.

### `engine help` (or `--help`)

Prints a usage JSON (command map, stage order, exit codes) and exits **0** —
the one command that never refuses. Unknown commands still exit 2.

## events.jsonl

Every state transition appends one event: `run_created`, `stage_begin`,
`stage_end`, `stage_blocked`, `gate_raised`, `gate_opened` — each with a UTC
`ts`. Append-only, derived, safe to delete (only curator's timeline consumes it).

## Live view (`engine step` + `engine live`)

**Doctrine, unchanged from the MVP.** Per **D1** (files authoritative,
`events.jsonl` additive-only): `engine step` is NOT automatic tool/thinking
transcript capture — there is no transcript telemetry today — it is a verb a
stage/skill calls itself to say "here is a step I am doing" so the live view
can render a checklist. It never touches `stage-status.json` and never
interacts with a gate; it only appends a `step` event, additive-only.

`engine step <label> --run <id> [--repo <path>] [--kind tool|thinking|plan|answer]
[--status todo|doing|done]` records one explicitly-emitted checklist entry (or,
with `--kind answer`, one chunk of the streamed final answer — see below).
Refuses (exit 2) without a label or `--run`.

**Coalescing identity (the flip: ⏳ → ✓, never a duplicate row).** The live
view derives an ORDERED, COALESCED checklist from `step` events plus the
engine's own lifecycle events (`stage_begin`/`stage_end`/`gate_raised`/
`gate_answered`). Each item's identity key is:

- `step` events (kind `tool`/`thinking`/`plan`): `<kind>\0<label>`
- `stage_begin`/`stage_end`: `stage:<stage>` (`doing` → `done`)
- `gate_raised`/`gate_answered`: `gate:<gate-or-decision-id>` (raise writes
  `gate: gateDef.name`, answer writes `gate: d.gate || d.id` — labels match)

The FIRST occurrence of a key fixes the item's position in the list (ordering
preserved); every later occurrence updates only `status` + `ts_last` —
**last-wins**, honest to the log. A regression (e.g. `done` → `doing` if an
emitter re-emits) is rendered as-is: the log is authoritative, and fabricating
a monotonic progression would violate the same honesty doctrine as
`{recorded:false}` in `docs/benchmarking.md`. Corrupt lines are skipped, never
thrown; absence of the log is distinguished from an empty checklist via
`steps_recorded`, so an empty-but-complete checklist is never rendered as if
it were checked off — an absent/empty checklist renders "no steps recorded"
instead.

**Answer chunks (`--kind answer`).** A `step` event with `--kind answer` is
NOT a checklist item — its `label` is one chunk of the streamed final answer.
Chunks concatenate in event (i.e. append) order into one answer pane;
`--status` is ignored by the renderer for this kind. No chunks recorded →
the answer pane is omitted entirely (never rendered empty).

### `engine live <run-id> [--run <id>] [--watch [--interval-ms 500] [--timeout-s N]]`

Renders ONE run's live view — the coalesced checklist plus the streamed
answer pane — to `<DETENT_ROOT>/.plans/engine-live-<run-id>.html`. Read-only:
no engine write path, `events.jsonl` schema, or D1 authority changes; the only
additive schema change anywhere in this feature is the `"answer"` step kind.

**The streaming mechanism is a re-write + `<meta http-equiv="refresh">`, not a
push channel.** Curator re-reads the registered artifact from disk on every
`GET /artifact/<id>` with `Cache-Control: no-store` (`engine/curator/server.mjs`).
So repeatedly re-writing this HTML file IS true incremental streaming, through
curator **and** plain `file://` alike — no curator changes, no in-page fetch
polling (which is blocked on `file://` and would need a new curator endpoint —
rejected: bigger blast radius for no gain). The `<meta http-equiv="refresh"
content="2">` tag is present in the artifact ONLY while the run is live; the
instant the run completes (every stage `done`/`skipped`), the refresh tag is
dropped and a final, stable static render is written — safe for a human to
annotate in curator without it reloading mid-annotation.

Without `--watch`: renders once, prints `{ok, run_id, artifact, complete,
steps_recorded, next_step}`, exits.

With `--watch`: engine's first long-running command, deliberately contained —
opt-in only, prints its start JSON line first (preserving the one-JSON-line-
per-invocation contract: it's the only line this invocation ever prints), then
silently polls `events.jsonl` **and** `stage-status.json` via `statSync`
size/mtime (not `fs.watch`, which is platform-flaky) at `--interval-ms`
(default 500) and re-renders on any change. Exits 0 the instant the run is
complete (`isRunComplete`) or `--timeout-s` elapses — always leaving whatever
it last rendered in place, a stable file once the process stops touching it.

Refuses (exit 2) without a run id, or for an unknown run id.

## Not in scope (state explicitly)

- **Automatic tool/thinking transcript capture.** No such telemetry exists;
  `engine step` and `--kind answer` are explicit emission only, never
  inferred from a transcript.
- **curator push/websocket streaming.** The re-write + meta-refresh mechanism
  above gets incremental updates through curator's existing per-GET,
  no-store re-read with zero server changes; a push channel is a separate,
  larger-blast-radius change this slice does not make.

## Tests

```
node --test engine/cli/tests/
```

Covers: run-id creation and immutability, legal/illegal stage transitions,
artifact enforcement, intent-gate raise/block/answer flow, decision-blocked
begin, curator vs terminal gate rendering, exec dispatch against fixture
commands, skill/mcp_tool instruction blocks, knowledge fan-out merge, partial
failure, all-fail abort, worktree-default run creation (`--no-worktree`
opt-out, unborn-HEAD refusal, no half-created run dirs), centralized-home run
scoping per work repo, dashboard data assembly + self-contained-artifact
rendering, and `engine respond --pr` (synthetic run creation, `skipped`-status
priors, PR-state refusals, PR-head-branch worktree, gate machinery on
`respond`) against a PATH-shimmed fake `gh` — no network in tests. Fixtures
are synthetic (`tests/fixtures/`); every test runs against a throwaway
`DETENT_ROOT`.

`tests/liveview.test.mjs` additionally covers the completed live view: flip/
coalescing semantics (doing→done in place, never a duplicate row), ordering
preservation, honesty (corrupt/absent log, no fabricated steps, "no steps
recorded", answer pane omitted when nothing streamed), streamed-answer-chunk
concatenation, meta-refresh presence iff `!complete`, the `engine live` CLI
(one-shot + missing/unknown run-id refusals), and an offline end-to-end
`--watch` run (spawned in the background, an appended `step` event observed
flipping in the artifact, completion via a direct `stage-status.json` edit,
exit 0, final artifact has no meta-refresh).

## Not in v0 (explicitly)

- `--socket-version` pin verification at assembly time (stack.example.yaml
  documents it; the CLI does not enforce it yet).
- Redaction, respond-poll watcher, per-stage permission profiles — separate
  blueprint items, not this CLI slice. (Worktree management has landed:
  `run new` creates the run worktree by default; pruning /
  recreation stays manual `git worktree` for now.)
- Stage skills for plan/implement/recheck/ship/respond (only intake + research
  exist under `engine/stages/` today); the CLI enforces their transitions anyway.


## `spend`, `attempt`, `env` — cost measurement and handoff producers

`engine spend [--days 30] [--record] [--note "<why>"]`
: What Claude Code actually cost, measured from the transcripts under
  `~/.claude/projects` (walked recursively — sub-agent transcripts nest under
  `<session>/subagents/`, and a fixed-depth glob silently drops all of them).
  Reports `by_origin` (main vs sub-agent), `by_model`, `by_day`,
  `strong_tier_share`, `expired_rates`, and a `coverage` block so an under-scan
  is visible rather than merely absent. `--record` appends to
  `benchmarks/spend-ledger.jsonl` and diffs against the previous line; see
  `benchmarks/README.md` for what makes two lines comparable. **The total is a
  lower bound — reconcile against the usage console.**

`engine attempt "<approach>" --run <id> --outcome failed|abandoned|superseded [--evidence "<why>"] [--stage <s>]`
: Record an approach that did NOT work, appended to `<run>/attempts.jsonl`.
  Append-only and uncapped: long runs accumulate dozens of dead ends, and the
  point is that a dead end stays dead. Required by the handoff from
  `implement` onward — without it a fresh session re-walks ground already covered.

`engine env --run <id> --verify "<cmd>" [--build|--start|--lint "<cmd>"] [--gotcha "<trap>"]`
: Record how this repo is run, into `<run>/env.json`. Merges rather than
  replaces, so adding a gotcha later does not drop the verify command.
  `commands.verify` is mandatory from `implement` onward: without it a successor
  cannot check its own work, which is the one thing no other artifact substitutes
  for. Removal is by editing the file — there is deliberately no `--unset`.

All three are read by `engine handoff`; see `engine/stages/CONTRACT.md`
("Episodes") for why the boundary exists and what it refuses.
