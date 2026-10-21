# SDLC Engine — generic layer

A company-agnostic engine that drives a change from ticket to merged PR. All
company-specific behavior lives behind **sockets**: small command-line
contracts declared in `stack.yaml`. The engine itself contains no company
names, no internal hostnames, no proprietary process — it is designed to be
published as-is. Examples use the fictional **AcmeCo**.

## The pipeline

Every change moves through the same stages:

1. **Intake** — pull the work item through the `ticket` socket; normalize it
   into engine ticket JSON.
2. **Research** — query one or more `knowledge` providers (runbooks, ADRs,
   repo docs, wikis — whatever the company wires in) and merge the results.
3. **Plan** — draft the implementation plan; discover applicable skills/plays
   via `skill-discovery`. The plan is reviewed **visually via curator**
   (rendered for a human to eyeball, not just dumped as text).
4. **Intent check** — before touching code, restate what the change is meant
   to do and confirm it matches the ticket. Cheap gate, catches wrong-problem
   work early.
5. **Implement** — make the change (TDD where there is logic).
6. **Recheck** — diff the implementation against the stated intent from step 4;
   drift means back to plan, not forward to review.
7. **Review / test / docs / lint** — run the `reviewer` socket (extra
   company-specific findings on top of the engine's own review), tests, docs
   updates, and lint.
8. **PR** — open the pull request; the `verifier` socket runs tests **and**
   captures end-to-end evidence artifacts. Unit tests passing is not
   sufficient evidence.
9. **Standing bot-comment loop** — until the PR merges, poll the
   `bot-comments` socket, classify what arrived (bot vs human, actionable vs
   informational), and act on the actionable ones.

Post-merge, the `incident` socket is the hook for investigations if something
goes wrong in the wild. The `deploy-harness` socket sits **outside** the
per-change pipeline entirely — see the warning in its contract.

## Sockets

Each socket is a command the engine invokes with a single JSON request on
stdin; the command emits a single JSON response on stdout. stderr is free-form
logging. Exit codes are uniform across all sockets:

| Exit | Meaning | Engine behavior |
|------|---------|-----------------|
| 0 | success | consume the JSON |
| 1 | provider failure (network, auth, not found) | retry once with a warning, then surface the error — never silently continue |
| 2 | contract violation (bad input, misconfiguration) | halt the stage and ask the user |

| Socket | Contract | Consumed by | Purpose |
|--------|----------|-------------|---------|
| `ticket` | [sockets/ticket.md](sockets/ticket.md) | intake | fetch and normalize the work item |
| `knowledge` | [sockets/knowledge.md](sockets/knowledge.md) | research | context lookup; **multiple providers, aggregated** |
| `skill-discovery` | [sockets/skill-discovery.md](sockets/skill-discovery.md) | plan | find applicable skills/plays for the task |
| `reviewer` | [sockets/reviewer.md](sockets/reviewer.md) | review | company-specific findings, each with `action` and `risk_level` |
| `verifier` | [sockets/verifier.md](sockets/verifier.md) | PR | run tests + capture end-to-end evidence artifacts |
| `bot-comments` | [sockets/bot-comments.md](sockets/bot-comments.md) | standing PR loop | watch PR comments; classify bot/human, actionable/informational |
| `skills-pack` | [sockets/skills-pack.md](sockets/skills-pack.md) | pipeline assembly | how a domain team plugs extra stages/skills into the pipeline |
| `incident` | [sockets/incident.md](sockets/incident.md) | post-merge | investigation hook when a merged change misbehaves |
| `deploy-harness` | [sockets/deploy-harness.md](sockets/deploy-harness.md) | **explicit trigger only** | heavyweight deploy-and-test in a real environment |

Wiring lives in `stack.yaml` (see [stack.example.yaml](stack.example.yaml) for
a fully commented AcmeCo example with a `version` per provider; the CLI does
not enforce it yet).

## Reference adapters

`adapters/` contains small, zero-dependency, working implementations you can
wire in immediately or copy as templates. Each emits agent-ergonomic output: a
JSON object that always includes a `next_step` hint telling the calling agent
what to do with the result.

| Adapter | Socket | What it does |
|---------|--------|--------------|
| `adapters/gh-ticket` | ticket | GitHub issue → ticket JSON via `gh` |
| `adapters/repo-docs-knowledge` | knowledge | greps a repo's README/docs/ for a query → knowledge JSON (one provider among many) |
| `adapters/gh-bot-comments` | bot-comments | lists PR comments via `gh`, tags bot vs human, classifies actionable vs informational |
| `adapters/claude-reviewer` | reviewer | sends the diff to a signed-in `claude` CLI and returns findings (spends tokens) |
| `adapters/cmd-verifier` | verifier | runs your test command and your evidence command, passes only when every claim has evidence |

Smoke tests live in `adapters/tests/` and run against a public repo
(`cli/cli`); they need an authenticated `gh` and node.

## Guardrail: company-strings check

`scripts/company-strings-check.sh` is a pre-push guard that greps the entire
`engine/` tree for company-identifying strings. **Each company maintains its
own denylist locally** at `engine/.local/denylist.txt` — one fixed string per
line, `#` comments allowed. The `.local/` directory is gitignored: the
denylist itself is company-identifying and must never be committed. A missing
or empty denylist is a loud exit-2 failure, not a silent pass. Test:
`scripts/tests/test-company-strings-check.sh`.

## Extending the pipeline

Domain teams do not fork the engine. They ship a **skills pack**
([sockets/skills-pack.md](sockets/skills-pack.md)) — a versioned directory of
extra stages/skills that the engine splices into the pipeline at declared
insertion points via `stack.yaml`.

## Credits

See [NOTICE.md](NOTICE.md).
