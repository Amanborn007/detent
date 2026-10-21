# Stage data contract — the `.sdlc/<run-id>/` run directory

Every engine run is a plain directory of files. No daemon, no database, no hidden state:
you can `ls`, `cat`, and `git diff` a run at any point and know exactly where it stands.
Stages communicate ONLY through these files — a stage never depends on the conversation
history of a previous stage.

## The pipeline these files serve

```
intake -> research -> plan (rendered in curator) -> intent check -> implement
       -> recheck -> review/verify/docs/lint -> PR -> bot-sentinel loop
```

This contract covers the whole run directory; stages 1–2 (intake, research) are
implemented today as skills in `engine/stages/intake/` and `engine/stages/research/`.

## Run directory layout

Run state is **centralized in the detent clone**, not the working repo: run
directories live under `${DETENT_ROOT}/.sdlc/` (with `DETENT_ROOT` falling back
to the detent clone the engine CLI lives in). Tasks routinely span multiple
repos, so attaching run state to any single work repo makes little sense — every
run, whatever repos it touches, points at the one detent home. Curator
artifacts are centralized the same way, under `${DETENT_ROOT}/.plans/`.
`.sdlc/` MUST be gitignored in the detent clone — run state is local working
state, not product code (the engine wiring adds the ignore entry if missing).

The DEFAULT flow is **worktree-based**: `engine run new` creates a dedicated git
worktree of the work repo at `<run-id>/worktree` on branch `sdlc/<run-id>` — that
worktree is the run's working area (implement/ship/respond act there; the primary
checkout is never dirtied). The worktree is disposable — prune it and recreate it
from the branch at any time; the run STATE files below are not. `--no-worktree`
opts out for repos where a worktree is impossible or unwanted.

```
${DETENT_ROOT}/.sdlc/
  <run-id>/
    run.json             # run identity: ticket ref, work repo(s) via repos[], worktree, branch, created_at
    worktree/            # the run's working area — a git worktree of the work repo
                         # on branch sdlc/<run-id> (default; disposable, branch is durable)
    brief.md             # stage 1 output (intake)
    research.md          # stage 2 output (research)
    access-report.json   # stage 2 output — per-source reachability (see engine/sources/PREFLIGHT.md)
    plan/
      plan.md            # stage 3 output — the artifact curator renders
    decisions.json       # human answers from curator gates (see schema)
    stage-status.json    # per-stage status ledger (see schema)
    attempts.jsonl       # append-only log of approaches tried and rejected (see "Episodes")
    env.json             # how to run this repo: commands.verify + gotchas (see "Episodes")
    handoff/
      <stage>.md         # successor-facing index, written by `engine handoff`
```

`engine dashboard` renders every run under the centralized `.sdlc/` — per-run
stage, status, pending gates, and age — into one self-contained curator
artifact, so all active runs are checkable from a single place.

### run-id

`<YYYY-MM-DD>-<ticket-key-lowercase>-<slug>` — e.g. `2026-07-04-proj-2534-retry-webhooks`.
No ticket? Use `adhoc` as the key: `2026-07-04-adhoc-fix-flaky-ci`. run-ids are
immutable once created; a re-run of the same ticket is a NEW run directory.

### `run.json` and multi-repo scope — `repos[]`

`run.json` carries a **`repos[]`** array: the work repo(s) this run touches.
The normal case is exactly one entry (the default worktree flow above; the
CLI's existing singular `repo` field remains valid as the single-entry
shorthand — readers treat `repo: X` as `repos: [X]`). More than one entry is
legal ONLY for a **multi-workspace run** — and entering that mode is a
**recorded human gate, never agent discretion**:

- **Trigger.** Research on an EXISTING ambiguous ticket reveals the change
  spans multiple repos (new tickets never have this problem: the drafting
  front door — stage 0 — enforces one-repo scoping at draft time, so a
  multi-repo ticket reaching the engine is by definition a pre-existing one).
- **The gate.** Research appends a pending decision (`blocks: ["plan"]`)
  presenting exactly two options, and plan may not proceed until a human
  answers it in curator:
  1. **split-first (DEFAULT)** — propose per-repo subtasks via the stage-0
     drafting flow (human-approved like any drafted set); ONE run per
     subtask; the original ticket becomes the coordination parent. Each
     resulting run has a single-entry `repos[]`.
  2. **multi-workspace (FALLBACK)** — one run, `repos[]` lists every repo,
     and `engine run new` materializes one worktree per entry
     (`worktree/<repo>/`, each on branch `sdlc/<run-id>`). The plan MUST
     then declare the **cross-repo ordering contract**: merge order,
     the mid-rollout compatibility mechanism (how the world works while
     repo A is merged and repo B is not), and the integration evidence
     that proves the repos compose. Ship opens N cross-referenced PRs;
     respond watches all N.
- The answered decision is the durable record of which path was chosen and
  why; a multi-entry `repos[]` with no answered split-vs-multi decision in
  `decisions.json` is a contract violation.

## Who writes what

| File               | Written by                              | Read by                     | Mutability |
|--------------------|-----------------------------------------|-----------------------------|------------|
| `run.json`         | `engine run new` (at run creation)      | all stages                  | write-once |
| `brief.md`         | intake ONLY                             | research, plan, intent check | replaced whole by re-running intake; never hand-patched by later stages |
| `research.md`      | research ONLY                           | plan, implement             | replaced whole by re-running research |
| `access-report.json`| research ONLY (writes the probe results); plan may re-probe on a retry/offline-copy and rewrite the affected records | plan (builds the access panel + hard-block), reviewers | replaced whole by re-running the preflight |
| `plan/plan.md`     | plan ONLY                               | curator, intent check, implement | replaced whole by re-running plan |
| `decisions.json`   | **curator only** (records human answers); stages may APPEND new pending decisions, never answer them | all stages | append + answer-once per decision |
| `stage-status.json`| the stage that is running (its own entry only) | all stages, curator | each stage owns its own key |

Two hard ownership rules:

1. **An agent never answers its own question.** Stages append decision blocks with
   `"status": "pending"`. Only curator — i.e., a human clicking/typing — flips a
   decision to `"answered"`. An agent writing an `answer` field is a contract violation,
   even if the answer seems obvious.
2. **A stage writes only its own artifacts.** Research does not edit `brief.md` to
   "fix" it; if the brief is wrong, research appends a pending decision saying so and
   marks itself `blocked`.

## `stage-status.json` schema

One object; keys are stage names in pipeline order. Statuses:
`pending` | `in_progress` | `done` | `blocked`.

```json
{
  "run_id": "2026-07-04-proj-2534-retry-webhooks",
  "stages": {
    "intake":   { "status": "done",       "artifact": "brief.md",    "updated_at": "2026-07-04T10:02:11Z" },
    "research": { "status": "done",       "artifact": "research.md", "updated_at": "2026-07-04T10:31:47Z" },
    "plan":     { "status": "in_progress","artifact": "plan/plan.md","updated_at": "2026-07-04T10:32:01Z" },
    "intent_check": { "status": "pending" },
    "implement":    { "status": "pending" },
    "recheck":      { "status": "pending" },
    "ship":         { "status": "pending" }
  }
}
```

- A stage sets itself `in_progress` on entry and `done`/`blocked` on exit, touching no
  other key. Write via temp-file-then-rename (`mv`) so a reader never sees a torn file.
- `blocked` MUST carry a `"blocked_on"` field naming the decision id(s) or error:
  `{ "status": "blocked", "blocked_on": ["D-003"], "updated_at": "..." }`.

## `decisions.json` schema

An array of decision blocks. These are the curator gates: every open question an agent
would otherwise silently assume becomes a block here, and curator renders pending
blocks as gates for the human.

```json
[
  {
    "id": "D-001",
    "raised_by": "intake",
    "blocks": ["implement"],
    "question": "Ticket says 'retry failed webhooks' — retry forever with backoff, or cap at N attempts then dead-letter?",
    "options": ["capped retries + dead-letter", "infinite backoff", "other (specify)"],
    "context": "brief.md#unknowns U1",
    "status": "pending"
  },
  {
    "id": "D-004",
    "raised_by": "research",
    "blocks": ["implement"],
    "question": "Found existing util `lib/retry.ts` (exponential backoff, used by 3 callers). Reuse it or write webhook-specific retry?",
    "options": ["reuse lib/retry.ts", "new implementation"],
    "context": "research.md#existing-help",
    "status": "answered",
    "answer": "reuse lib/retry.ts",
    "answered_by": "human",
    "answered_at": "2026-07-04T10:40:12Z"
  }
]
```

Field rules:
- `id`: `D-` + zero-padded ordinal, unique within the run; assigned at append time.
- `blocks`: which pipeline stages may NOT run while this decision is `pending`.
  Default `["implement"]` — research and plan may proceed past an open question
  (plan must present pending decisions in its curator render), but nothing that
  changes code may. A decision that invalidates planning itself uses `["plan"]`.
- `status`: `pending` | `answered` | `withdrawn` (a stage may withdraw its OWN
  still-pending question if later evidence moots it — record `withdrawn_reason`).
- Append-only otherwise: never delete or rewrite an answered decision. New information
  after an answer = a new decision block referencing the old id.
- `cause` (optional, but should be set by whichever stage raises the decision):
  what kind of block this is, so a dashboard or handoff note can tell a
  20-second VPN fix from an unmade decision. One of:

  | `cause` | What's blocking | Proceedable? | Unblocks via |
  |---|---|---|---|
  | `external` | A named person or team must act: a Slack reply, a review, a sign-off. | Yes | their reply |
  | `infra` | VPN, credentials, a service down, an access grant: the source does not answer at all. | Yes | `enable_action` plus a re-probe |
  | `capability` | Only a human at a browser/terminal can do this step (e.g. complete an OAuth flow). | Yes, always needs a human but is not a judgment call | a generated wizard |
  | `data` | The source answers, but the data isn't there yet. | Yes, with the assumption stated | the source populating, then a re-probe |
  | `judgment` | Nothing external blocks it; it needs the owner's call. | **No, never, while a human is present.** No override flag exists for this, ever. | the owner reading the gate |

  `external-human` and `external-team` collapse into one `external` value:
  nothing branches on which, and the identity that would distinguish them is
  exactly what `waiting_on` already carries as free text. `capability` stays
  separate from `infra` because the unblock mechanism differs: `infra` clears
  via an unattended re-probe, `capability` always needs a human doing
  something, just not deciding something. `data` vs `infra`: if the source
  answers but has nothing yet, it's `data`; if the source doesn't answer at
  all, it's `infra`. A decision with no `cause` recorded reads as
  **unclassified**, not as `judgment`; renderers must not default an absent
  cause to the strictest reading.
- `waiting_on` (optional): a free-text string naming who or what unblocks this,
  a person, a team, a service, a ticket key. Required in practice for
  `external`, `infra`, and `capability` (nothing in this repo validates decision
  shape, so "required" here is a documentation contract, not an enforced one).
  Optional for `data`. Meaningless for `judgment`, which waits on the owner
  reading the gate, not on any external party.
- `degraded_assumption` (only on an answered decision whose `answer` is the
  proceed-degraded string below): free text stating exactly what is being
  assumed in the blocked information's absence, so a successor knows what was
  accepted and doesn't mistake "accepted degraded" for "fully resolved".

### The proceed-degraded answer

CONTRACT.md's access hard-block (below) already has one answer string for a
human accepting a degraded state: **`proceed degraded (accept degraded
confidence)`**. This is the ONE vocabulary for that acceptance across every
`cause`, not just `access-degraded`: a human recording this answer on an
`external`/`infra`/`capability`/`data` decision means the same thing everywhere
it appears, proceed, and the gap stated in `degraded_assumption` is accepted,
not resolved.

This string is legal only where an external/infra/capability/data unblock is
being accepted. It can never legally appear as the answer to a `judgment`
decision, because that would launder "the owner hasn't decided yet" into "the
owner accepted a degraded state", which is not what happened. The gate rule
below is mechanical about this: `engine`'s pending-blocker check treats a
`judgment` decision answered with this exact string as still blocking, the
same as a still-`pending` one. There is no override flag for `judgment`;
generalizing this string to every cause must not quietly create one.

## The gate rule

> **The invoking agent never skips a gate that has status `pending`.**

Concretely, before starting stage S, the invoking agent MUST:

1. Read `decisions.json`.
2. If any decision has `"status": "pending"` and `S ∈ blocks`, DO NOT run S.
   Set (or leave) S as `pending`, surface the pending questions to the human
   (via curator when wired; verbatim in chat when running manually), and stop.
3. "The answer is obvious", "the human is unavailable", and "we can undo it later"
   are all non-exceptions. There is no override flag.

This is the whole point of the file-based design: a gate is a *file state*, not a
conversational promise, so a fresh agent with zero context still can't skip it.

### Benchmark checkpoint — a parked run always has its benchmark-so-far recorded

> **Whenever a run parks on a gate (a human answer or an async-external
> sign-off), a PARTIAL benchmark of the work done up to that point is written
> BEFORE the wait begins — never only at run completion.**

A human/async answer can take hours or days (a cross-team PENDING-EXTERNAL
sign-off especially), so a benchmark that is only emitted when the run finally
finishes leaves every parked run unmeasured for the whole wait. The rule mirrors
the gate-artifact rule ("every gate artifact is ALWAYS produced"): the benchmark
of the agentic work is always in place at the park.

Mechanically:

- **Engine-driven gates auto-checkpoint.** The CLI writes a checkpoint the
  instant it parks a run — when `engine stage end` refuses on a pending gate,
  and when `engine gate open` renders a gate for a human. No skill action
  needed; this covers every stage gate for every engine-driven skill.
- **A skill that parks on its OWN async gate calls it explicitly:**
  `engine bench <run-id> --checkpoint --reason <what-it-waits-on> [--gate <id>]`
  the moment it parks (e.g. a connector-read wait, a cross-team sign-off drafted
  and sent, an owl decision-journal branch). Idempotent under retry: a repeat
  call with no new events since the last checkpoint is a no-op.

Each checkpoint (a) refreshes `<run>/benchmark.json` (latest snapshot — one
always exists), (b) appends the full record to `<run>/benchmark-checkpoints.jsonl`
(the growing per-run set), and (c) appends a `partial: true` line to the central
`benchmarks/ledger.jsonl`. The measured window ends at the park event, so the
pending wait is not counted; a final `engine bench` at completion supersedes it
with the authoritative whole-run numbers.

### Access hard-block — a blocked CRITICAL source stops plan approval

The preflight ([`../sources/PREFLIGHT.md`](../sources/PREFLIGHT.md)) records every
needed source in `access-report.json` with a `status` (`reachable | blocked | partial`)
and a `criticality` (`critical | important | optional`). The plan gate keys off it:

> **The plan gate cannot be approved-for-implementation while any source with
> `criticality: "critical"` has `status: "blocked"`, unless the human explicitly
> records "proceed degraded" for that specific source.**

Mechanically this reuses the existing gate rule — no new override machinery:

- For **every** `access-report.json` record with `criticality == "critical"` and
  `status == "blocked"`, the plan stage appends a decision of `kind:
  "access-degraded"`, `raised_by: "plan"`, `blocks: ["implement"]`, naming the source,
  what it feeds, and its `enable_action`. Options are the inline unblock controls:
  retry (now reachable), provide an offline copy at a path, or **proceed degraded**.
- Because that decision `blocks: ["implement"]`, the standard gate rule already forbids
  implement while it is `pending`. So even if the human answers the plan's `intent`
  gate, implement stays locked until each critical blocked source's
  `access-degraded` decision is resolved by one of:
  1. **proceed degraded** — the human accepts the degraded confidence (recorded in
     `decisions.json`, `answered_by: "human"`); or
  2. **retry / offline copy that succeeds** — the source is re-probed to `reachable`
     (or `partial`) and `access-report.json` is rewritten; the decision is then
     `withdrawn` with `withdrawn_reason` citing the new probe.
- **Only a human selects "proceed degraded".** An agent writing that answer — or
  starting implement on a still-pending `access-degraded` decision — is the same
  contract violation as self-answering any gate. "The number probably wouldn't change
  the plan" is not an exception.

**Non-critical blocked/partial sources are advisory.** A `blocked`/`partial` source
with criticality `important` or `optional`, and a `partial` critical source, are
surfaced prominently in the plan gate's access panel and their dependent conclusions
are degraded-confidence, but they do NOT append a blocking `access-degraded` decision
— unless research/plan judges that a partial critical read leaves a critical
conclusion unsupported, in which case it is raised as a blocking decision like a
blocked-critical source. The mechanical hard-block is scoped to `critical` + `blocked`
so the rule is checkable from `access-report.json` alone.

### Episodes — a parked run ends its session, it does not hold one open

> **A run that parks on a gate closes the session. The next stage starts a fresh
> one and reconstructs from these files. Resuming a parked session is the
> expensive path, and it is never the required one.**

This is the operational consequence of the rule at the top of this document —
"stages communicate ONLY through these files" — plus the observation that a
human/async answer "can take hours or days". A session held open across that
wait has nothing to hold: the state is already on disk.

**Why it is worth naming as a rule.** A turn resumed after the prompt cache
TTL (about an hour) re-uploads the whole context, so a cold turn costs many
times a warm one while being a small share of all turns. `engine spend` splits
your own traffic into warm, mid and cold turns so you can read the share.

A parked gate guarantees that penalty; an episode boundary avoids it entirely,
since a fresh session pays for the artifacts it reads and nothing else.

**Cost is not the binding constraint — quality is.** Cutting episodes shorter
always looks cheaper, which means cost alone would argue for ending every
session immediately. The real limit is that a successor must not have to
rediscover what its predecessor knew, and must not re-walk approaches already
ruled out. Two artifacts exist for that, and both are part of this contract:

```
  <run-id>/
    attempts.jsonl       # every approach tried and rejected, append-only, UNCAPPED
    env.json             # how to run things here: commands.verify is mandatory
    handoff/<stage>.md   # generated index a fresh session reads first
```

- **`attempts.jsonl`** — one JSON object per line:
  `{ts, stage, approach, outcome: "failed"|"abandoned"|"superseded", evidence}`.
  Append-only and deliberately **uncapped**: long runs accumulate
  dozens of distinct failed approaches. A cap would discard most of the record, and the point of the file is that a dead end
  stays dead. The generated note projects at most 5 of them — that is a
  readability budget, not a storage one, and the note says how many it omitted.
- **`env.json`** — `{commands: {verify, ...}, gotchas: []}`. `commands.verify` is
  mandatory from implement onward: without it a successor cannot close the loop
  on its own work, which is the one thing no artifact can substitute for.
- **`decisions.json` gains `rejected_options`** on answered decisions —
  `[{option, why_not}]`, that shape exactly. An answer without its discards
  invites a successor to re-propose a rejected option in good faith, having no
  way to see it was already weighed.
- **`decision-rationale.jsonl`** — `{ts, decision, option, why}`, append-only,
  written by `engine decide-why`. A SIDECAR, deliberately not a field on the
  decision, because two rules collide otherwise: an answered decision may never
  be rewritten (above), and curator — the only writer permitted to answer —
  records just `{question, answer}`, so a reason has nowhere to land inside the
  block. The handoff merges the two and treats a discard with NO recorded reason
  as a hard gap: knowing that an option lost does not stop a successor
  relitigating it, only knowing why does.

**The boundary is checked, not assumed.** `engine handoff <run-id>` writes
`handoff/<stage>.md` and **refuses (exit 2)** when the handoff would lose
something a successor needs. `--force` writes it anyway with a visible
INCOMPLETE banner naming each gap. There is no silent path: an episode boundary
that quietly drops a dead end costs more in rework than the cold resume it
saved, so the failure is made loud rather than cheap.

**Where the boundary fires automatically.** Three points, and no others:

| Boundary | Why it is one | Blocking? |
|---|---|---|
| `stage end` refused on a pending gate | The next move is a human's; the wait is hours-to-days. | No — the gate refusal is the outcome; the handoff rides along. |
| `gate open` rendered a gate | Same: the human now owns the next move. | No. |
| A stage completed (status `done`) | Nobody is waited on, but the next stage reads FILES, not conversation — so the finishing session holds nothing it needs. Keeps each episode's context proportional to one stage rather than the whole run. | No — advisory; `next_step` still names the next command. |

Mid-stage checkpoints are deliberately NOT wired. Part-way through a stage there
is no file-complete point to hand over from, so a boundary there would be
precisely the lossy kind these artifacts exist to prevent.

| File | Written by | Read by | Mutability |
|---|---|---|---|
| `attempts.jsonl` | any stage that tries and rejects an approach, via `engine attempt` | later stages, `engine handoff` | append-only, never rewritten |
| `env.json` | the first stage to establish how the repo runs, via `engine env` | all later stages | replaced whole when the facts change |
| `decision-rationale.jsonl` | any stage, via `engine decide-why` | `engine handoff` | append-only; never rewritten, and never touches `decisions.json` |
| `handoff/<stage>.md` | `engine handoff`, or the CLI at an episode boundary (see "Where the boundary fires automatically") | the NEXT session, first thing | regenerated per episode |

### Gate exercise modes — {live, eval-simulated, parked-no-send}

Gates are sometimes exercised without a human on the other end (dry runs,
offline evaluations, environments where outbound writes are forbidden). The
contract for that is a state machine, not an ad-hoc skip:

- **Every gate artifact is ALWAYS produced, in every mode.** The artifact
  (plan render, approach cards, drafted set, outbound-request drafts) is the
  gate's evidence; "we didn't open the gate" never excuses not authoring it.
  An unexercised gate must be reconstructable after the fact from files alone.
- Each gate decision record carries an **`exercise_state`** field:

| `exercise_state` | Meaning | May the run proceed past the gate? |
|---|---|---|
| `live` | Artifact opened in curator; a HUMAN answered. | Yes — this is the only state that authorizes side effects (creates, posts, sends, merges). |
| `eval-simulated` | Evaluation/dry-run: no human available; a simulated decision was recorded WITH the assumption it rests on ("simulated as top-scored option"). | Only in an eval-context run, and every downstream artifact inherits a visible "decision simulated" caveat. Never in a live run. |
| `parked-no-send` | Artifacts and outbound drafts exist in full, but sending/creating is blocked (approval missing, or the environment is no-send). | No — the run parks. Degraded form of externally-blocked gates: the drafts exist, nothing goes out, resumption re-enters the gate. |

- Only curator (a human) writes `live` answers — the existing ownership rule
  is unchanged. `eval-simulated` and `parked-no-send` are recorded by the
  stage that hit the gate, and the record MUST name the mode's justification
  (which eval, what blocks sending).
- **Gate-state laundering is a contract violation**: reporting an
  `eval-simulated` or `parked-no-send` gate as approved, or a live run
  acting on a non-`live` gate state.
- Skills with their own gates (e.g. the ticket-drafting front door, stage 0)
  follow this same state machine for their gate records.

**Curator via subagents (context discipline).** All curator *mechanics* —
authoring the HTML artifact, `open`, the blocking `poll`/`reply` loop, and
applying raw feedback JSON — are delegated to a subagent, never run in the main
conversation. The main agent receives only the distilled outcome: the decisions
answered and a summary of the human's annotations. Poll JSON, `next_step`
chatter, and server output never enter the main thread. Every stage-gate
procedure follows this rule (each stage skill restates it at its gate step).

## Invariants (checkable with `cat` and `jq`)

- Every `U*` unknown listed in `brief.md` has a matching `D-*` block in `decisions.json`.
- `research.md` exists ⇒ `stages.intake.status == "done"`.
- `plan/plan.md` exists ⇒ `stages.research.status == "done"`.
- Any code change in the working tree attributable to the run ⇒ no pending decision
  with `"implement"` in `blocks` existed at the time implement started.
- `plan/plan.md` exists ⇒ `access-report.json` exists (the plan is built on a probed
  access surface, never an unprobed one).
- Every `access-report.json` record with `criticality == "critical"` and
  `status == "blocked"` ⇒ a matching `kind: "access-degraded"` decision exists, and
  implement did not start while it was still `pending` (resolved by an answered
  "proceed degraded", or `withdrawn` after a re-probe to reachable).
- All timestamps UTC ISO-8601; all JSON written atomically (temp + rename).

## Failure handling

A stage that cannot complete (socket command fails, artifact unwritable) sets its own
status to `blocked` with a specific `blocked_on` message and stops loudly. It never
writes a partial artifact as if done, never falls back to invented content, and never
marks itself `done` "optimistically".

### Self-feedback journal

When a stage hits a defined coverage gap (scout no-hit, respond stuck, preflight
blocked-source) it SHOULD append an advisory entry via `detent feedback add` — see
[`../self-feedback/CONTRACT.md`](../self-feedback/CONTRACT.md). Entries never gate or
block anything.
