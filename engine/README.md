# Engine

The engine takes one ticket to a reviewed draft PR. Everything specific to a company or a tool sits behind sockets, which are small command-line contracts declared in `stack.yaml`. The engine has no company names or internal hostnames, and the examples use a fictional AcmeCo.

## Stages

A run moves through seven stages: intake, research, plan, implement, recheck, ship and respond. The stage prompts are in `stages/`, and [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) traces one run through them.

- The intent check is the plan gate. You answer it in curator before implement starts.
- Review, verification and opening the PR all happen in ship. Ship runs the `reviewer` and `verifier` sockets, waits for your yes, then opens a draft PR.
- The standing bot-comment loop is respond. It starts when you mark the PR ready and stops at the round cap.

The `incident` socket is a hook for investigating a merged change that misbehaves. The `deploy-harness` socket sits outside the per-change run, and its contract allows a call only when a human asks, or as an opt-in final gate on an approved PR.

## Sockets

The engine runs a command, writes one JSON request to its stdin and reads one JSON response from its stdout. stderr is free-form logging.

| Exit | Meaning | Engine behavior |
|------|---------|-----------------|
| 0 | success | uses the JSON |
| 1 | provider failure (network, auth, not found) | retries once with a warning, then shows you the error. An exit 1 that carries a JSON body is kept as the response and is not retried, because a verifier's `verdict: fail` needs it. |
| 2 | contract violation (bad input, misconfiguration) | halts the stage and asks you |

| Socket | Contract | Used by | Purpose |
|--------|----------|---------|---------|
| `ticket` | [sockets/ticket.md](sockets/ticket.md) | intake | fetch and normalize the work item |
| `knowledge` | [sockets/knowledge.md](sockets/knowledge.md) | research | context lookup, with several providers aggregated |
| `skill-discovery` | [sockets/skill-discovery.md](sockets/skill-discovery.md) | plan | find skills that apply to the task |
| `reviewer` | [sockets/reviewer.md](sockets/reviewer.md) | ship | findings, each with `action` and `risk_level` |
| `verifier` | [sockets/verifier.md](sockets/verifier.md) | ship | run tests and capture end-to-end evidence |
| `bot-comments` | [sockets/bot-comments.md](sockets/bot-comments.md) | respond | watch PR comments and classify bot or human, actionable or informational |
| `skills-pack` | [sockets/skills-pack.md](sockets/skills-pack.md) | run assembly | plug extra stages and skills into the run |
| `incident` | [sockets/incident.md](sockets/incident.md) | after merge | investigation hook |
| `deploy-harness` | [sockets/deploy-harness.md](sockets/deploy-harness.md) | explicit trigger | deploy and test in a real environment |

Wiring lives in `stack.yaml`. [stack.example.yaml](stack.example.yaml) is a commented AcmeCo example with a `version` per provider. The CLI does not enforce `version`.

## Adapters

`adapters/` holds six zero-dependency implementations you can wire in or copy. Each returns JSON that includes a `next_step` hint for the calling agent.

| Adapter | Socket | What it does |
|---------|--------|--------------|
| `adapters/gh-ticket` | ticket | GitHub issue to ticket JSON, through `gh` |
| `adapters/repo-docs-knowledge` | knowledge | greps a repo's README and `docs/` for a query |
| `adapters/repo-index-knowledge` | knowledge | ranks the work repo's files against the query using `detent index` |
| `adapters/gh-bot-comments` | bot-comments | lists PR comments through `gh` and classifies them |
| `adapters/claude-reviewer` | reviewer | sends the diff to a signed-in `claude` CLI and returns findings. It spends tokens. |
| `adapters/cmd-verifier` | verifier | runs your test command and your evidence command, and passes only when every claim has evidence |

The smoke tests in `adapters/tests/` run against a public repo (`cli/cli`) and need an authenticated `gh`.

## Leak gate

`scripts/company-strings-check.sh` greps the `engine/` tree for strings on a denylist. Each company keeps its own at `engine/.local/denylist.txt`, one fixed string per line, `#` comments allowed. `.local/` is gitignored because the denylist is itself identifying. A missing or empty denylist exits 2. Its test is `scripts/tests/test-company-strings-check.sh`.

## Extending

Domain teams ship a skills pack ([sockets/skills-pack.md](sockets/skills-pack.md)), a versioned directory of extra stages and skills that `stack.yaml` splices in at declared insertion points. They do not fork the engine.

## Credits

See [NOTICE.md](NOTICE.md).
