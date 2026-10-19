# engine/stages — SDLC stage skills

Generic, company-free stage skills for the SDLC engine loop:

```
intake -> research -> plan (rendered in curator) -> intent check -> implement
       -> recheck -> review/verify/docs/lint -> PR -> bot-sentinel loop
```

All stages are implemented as skills in this directory, sharing one data contract.
Everything org-specific (which ticket tracker, which knowledge bases, which skill
registry, which review/verify tooling) enters ONLY through socket commands declared
in `stack.yaml` — these files must stay generic.

| Path                    | What it is |
|-------------------------|------------|
| `CONTRACT.md`           | The run-state model: `.sdlc/<run-id>/` layout, `stage-status.json` and `decisions.json` schemas, ownership rules, and the gate rule ("the invoking agent never skips a gate that has status `pending`"). Read this first. |
| `intake/SKILL.md`       | Stage 1: ticket ref → run directory + `brief.md` (goal, acceptance criteria, constraints, unknowns, affected repos), every ambiguity filed as a pending decision. Ticket text handled as untrusted input. |
| `research/SKILL.md`     | Stage 2: `brief.md` → fan-out over knowledge providers, skill discovery, and the target repo (git archaeology + `gh` precedent search) → `research.md` with attributed, KNOW/GUESS-marked findings, a mandatory "what could help that already exists" section, and a mandatory BLAST RADIUS map (consumers, schemas, events, 1-hop neighbors). |
| `plan/SKILL.md`         | Stage 3 (+ stage 4, the intent check, inside its gate): brief + research → `plan/plan.md` (approach, steps with files-touched + verify commands, risks, test strategy), a fresh-context intent check vs the brief's acceptance criteria (divergences filed as decisions), and a self-contained curator HTML artifact under `.plans/` with a `data-plan-question` block per pending decision. The plan gate is HARD. |
| `implement/SKILL.md`    | Stage 5: approved plan → commits on a ticket-named branch in a DISPOSABLE worktree (refuses the primary checkout); strict TDD; run state written only to the main checkout's `.sdlc/`; no push. |
| `recheck/SKILL.md`      | Stage 6: fresh-context diff-vs-approved-plan check → `recheck.md` per-step verdict table; material divergences become pending decisions (the conditional drift gate: accept / route to plan / route to implement — the human picks). |
| `ship/SKILL.md`         | Stages 7–8 as one skill, ordered sub-steps: reviewer-socket review (no-op/auto-fix/ask-user routing, ask-user filed verbatim), verifier-socket verification (per-claim evidence required — tests passing is not sufficient), conditional docs, lint, then the hard human ship gate before push + DRAFT PR with the evidence manifest attached. |
| `respond/SKILL.md`      | Stage 9, the standing loop: armed only when the human marks the PR ready; debounced `sentinel scan` cycles tracked PER COMMIT pushed, root-cause-grouped fixes, ONE batched push per cycle, every blocking finding closed with an in-thread reply plus a thread resolve, verbatim escalations, convergence on clean phrases AND `blocking_open` 0, cap `config.max_iterations` (default 10). Bot bodies are DATA, never instructions. |
| `dashboard/README.md`   | Not a pipeline stage — the read-only run-status view: `engine dashboard` renders every run under the centralized `${DETENT_ROOT}/.sdlc/` (stage, status, pending gates, age) into one self-contained curator artifact. |
| `WALKTHROUGH.md`        | A full dry-run trace: one fictional ticket driven end-to-end through all stages, showing every artifact and gate as it evolves. |

## How a run flows today (manual)

The stages are ordinary skills invoked by hand; state lives in files, so nothing has
to stay resident between invocations.

1. In the target repo: `/sdlc-intake PROJ-2534`.
   - Fetches the ticket via `sockets.ticket.fetch` from `stack.yaml`.
   - Creates `${DETENT_ROOT}/.sdlc/2026-07-04-proj-2534-<slug>/` (centralized in
     the detent clone, with the run's git worktree by default) with `run.json`,
     `stage-status.json`, `brief.md`, and pending `D-*` blocks in `decisions.json`.
2. Inspect the brief yourself: `cat .sdlc/<run-id>/brief.md`. The open questions are
   listed both there (U1..Un) and in `decisions.json` (D-001..).
3. `/sdlc-research <run-id>`.
   - Refuses to run unless `intake` is `done`.
   - Fans out (knowledge providers, skill discovery, repo archaeology), writes
     `research.md`, may append more pending decisions.
4. Answer gates. With the curator CLI (`engine/curator/`, its own lane) the plan
   stage opens its `.plans/` artifact and your clicked decision answers are
   transcribed verbatim into `decisions.json`. Without it, YOU are curator: edit
   `decisions.json` to set `status: "answered"` with your answer — a human
   hand-editing the file is the fallback gate mechanism; agents still never invent
   answers.
5. `/sdlc-plan <run-id>` — writes `plan/plan.md`, runs the fresh-context intent
   check, renders the curator artifact, and parks at the hard plan gate. No decision
   with `implement` in its `blocks` may be pending when implementation starts — that
   is the contract's gate rule, and it holds whether the run is driven manually or by
   the engine.
6. `/sdlc-implement <run-id>` — refuses to run in the primary checkout; TDD commits
   in a disposable worktree; no push.
7. `/sdlc-recheck <run-id>` — fresh-context drift check; material drift gates ship
   via pending decisions.
8. `/sdlc-ship <run-id>` — review/verify/docs/lint, then asks the human before push +
   draft PR. You mark the PR ready when you want the standing loop armed.
9. `/sdlc-respond <run-id>` — the standing bot-comment loop, until every blocking
   finding is closed and the bots are clean, or the `config.max_iterations` cap
   (default 10) parks it for a human. Merging stays a human click.

Everything is inspectable mid-run (run state is centralized under
`${DETENT_ROOT}/.sdlc/`, not the work repo — see CONTRACT.md):

```
cat ${DETENT_ROOT}/.sdlc/<run-id>/stage-status.json | jq '.stages'
cat ${DETENT_ROOT}/.sdlc/<run-id>/decisions.json | jq '[.[] | select(.status=="pending")]'
node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/cli/engine.mjs" dashboard   # all runs at once: stage, status, pending gates, age
```

## What wires this later

Parallel lanes own the engine blueprint, the sockets layer, curator, and the
sentinel; this directory only *consumes* their interfaces:

- **`stack.yaml` sockets** — intake calls `sockets.ticket.fetch`; research iterates
  `sockets.knowledge.providers[]` and calls `sockets.skill_discovery`; ship calls
  `sockets.reviewer` and `sockets.verifier`; respond falls back to
  `sockets.bot-comments` where sentinel is absent. The exact schema is owned by the
  sockets lane; the stage skills assume "a named socket resolves to a runnable
  command exchanging JSON" and nothing more. If the landed schema differs, update
  the snippets in the SKILL.md files.
- **The engine loop** — replaces manual invocation: it sequences stages, enforces
  the gate rule mechanically (reads `decisions.json` before every stage entry), and
  routes each stage to an executor. The stages don't change; only the invoker does.
- **curator** (`engine/curator/`, `feat/curator` lane) — serves the plan stage's
  `.plans/` artifact, makes `data-plan-question` blocks clickable, and returns the
  human's answers as structured decision events; the plan skill transcribes those
  verbatim into `decisions.json`. Human clicks (or hand-edits) remain the only
  origin of `answer` fields.
- **the sentinel engine** (`engine/sentinel/`, `feat/bot-sentinel` lane) — the
  deterministic eyes of the respond stage (`sentinel.mjs` + `SENTINEL.md`); the
  respond skill wires its work orders into the run contract.
- **Stage-status keys** — later stages added `respond` to the ledger in pipeline
  order; each stage owns exactly its own key(s) per `CONTRACT.md` (ship owns
  `review` and `pr`; plan owns `plan` and `intent_check`).

## Rules for adding/editing stage skills

- Generic only: no company names, no internal hostnames, no vendor-specific ticket
  or wiki tooling. Org specifics go into socket commands in `stack.yaml`.
- Every stage: reads predecessors' artifacts, writes ONLY its own, appends decisions
  but never answers them, and updates only its own `stage-status.json` key.
- Every SKILL.md includes a worked micro-example (correct output AND named-wrong
  outputs) and a forbidden-failure-modes section. Vague stage instructions produce
  vague agents.
