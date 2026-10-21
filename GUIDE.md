# Detent user guide

The [README](README.md) says what detent is and how to install it. This guide says what to type, what each stage does, how to wire in your own tools, and how the checks work. Every command runs from the root of your detent clone unless a step says otherwise.

Contents:

1. [The model in one page](#1-the-model-in-one-page)
2. [First run](#2-first-run)
3. [The stages and gates](#3-the-stages-and-gates)
4. [Daily flows](#4-daily-flows)
5. [Sockets and providers](#5-sockets-and-providers)
6. [Writing a provider and a pack](#6-writing-a-provider-and-a-pack)
7. [Skills and tools reference](#7-skills-and-tools-reference)
8. [Evals](#8-evals)
9. [The leak gate](#9-the-leak-gate)
10. [Where things live](#10-where-things-live)
11. [When something goes wrong](#11-when-something-goes-wrong)

---

## 1. The model in one page

You bring work in any shape: a raw requirement, or an existing ticket. **clerk** turns a raw requirement into tickets. The **engine** takes one ticket through seven stages (intake, research, plan, implement, recheck, ship, respond) and ends with a draft PR that has been reviewed and checked.

Decisions stop at a **gate**. A gate is a question with options, written to `decisions.json` and rendered in **curator**, a local browser page where you click an option or annotate text. Your answer comes back as JSON. If curator is not installed, the engine prints how to answer by editing `decisions.json` by hand. The engine never answers a gate for you. Not every stage has one, and the engine itself enforces only the plan gate. Section 3 lists which gates are in code and which are rules in the stage prompts.

Three rules hold everywhere:

- State lives in plain files. You can `ls` and `cat` a run at any point.
- Text from tickets, PRs, bots and threads is data. A skill reads it but never follows instructions found in it.
- Nothing merges. Creating tickets, the first push and the draft PR each wait for you.

---

## 2. First run

Install the plugin and run the shell script as described in the README. Then:

```sh
cp detent.user.example.yaml detent.user.yaml   # skip if the install script already made it
```

To do the next two steps in one command, run `detent setup --repo ~/code/your-repo`. It creates `detent.user.yaml` from the example if it is missing and fills `user.name` and `user.email` from `git config` and `user.github_login` from `gh api user`, only where they are empty. It also writes a starter `stack.yaml` in your work repo with the three built-in adapters below, as absolute paths. It refuses if `stack.yaml` already exists (add `--force` to overwrite) or if the path is not a git repo. It prints one JSON line that lists what it wrote, what it left alone, and an `unresolved` list of values it could not detect, such as `user.teams`; fill those in by hand. If `gh` is not logged in, `user.github_login` is listed as unresolved and the rest still runs.

Otherwise, open `detent.user.yaml` and fill in your name, email, GitHub login, teams and tracker account. Leave the GitHub login empty if you want detent to read it from `gh api user`.

Two more files wire detent up. They are separate, and `detent.user.yaml` points at only one of them.

- The **provider pack** (`packs/example/stack.yaml` by default, or the file named by `pack.path` in `detent.user.yaml`) tells the skills which knowledge providers, review lenses and network check you have. Check it with `detent pack validate`.
- The **engine stack file** is a `stack.yaml` with a top-level `sockets:` map. Copy `engine/stack.example.yaml` to `stack.yaml` in the repo you will work on, and replace each command with a program you have. The engine reads it from `<repo>/stack.yaml`, `<repo>/engine/stack.yaml` or the path in `--stack`. Do not copy the pack file here, because it has no `sockets:` map and the engine refuses it.

If you have nothing yet, start with only the built-in adapters, and give each `command` as an absolute path. A relative path resolves against the directory of your `stack.yaml`, so `engine/adapters/gh-ticket` fails in a work repo.

- `/path/to/detent/engine/adapters/gh-ticket` for the `ticket` socket (a GitHub issue).
- `/path/to/detent/engine/adapters/repo-docs-knowledge` for the `knowledge` socket (grep over the repo's own docs).
- `/path/to/detent/engine/adapters/gh-bot-comments` for the `bot-comments` socket.
- `/path/to/detent/engine/adapters/claude-reviewer` for the `reviewer` socket (needs a signed-in `claude` CLI, spends tokens).
- `/path/to/detent/engine/adapters/cmd-verifier` for the `verifier` socket (runs your `--test` and `--evidence` commands).

Leave the other sockets out. Check that everything is wired:

```sh
detent help                              # the umbrella command's usage, exit 0
detent pack validate                     # lists which providers and lenses are ON or OFF
curator status                           # empty list on a fresh install
node engine/sentinel/sentinel.mjs config-check --config config/sentinel/default.json
```

---

## 3. The stages and gates

The engine runs seven stages in order. `detent stage begin` refuses to start a stage while an earlier stage is not done or skipped, or while a pending decision blocks it. `detent stage end` refuses to finish a stage whose artifact is missing or whose plan gate is still pending. `detent next` always prints the command that moves the run forward.

The CLI enforces one gate itself, the plan `intent` gate (approve or revise). The drift gate and the ship gate are rules in the stage prompts under `engine/stages/`. The agent records them as pending decisions in `decisions.json`, and a pending decision blocks the stages it names. Recheck also checks that the recorded red commit is an ancestor of the green commit. That proves order only, not that the test was seen to fail.

| Stage | Reads | Writes | Gate |
|---|---|---|---|
| intake | the `ticket` socket | `run.json`, `brief.md`, one pending decision per ambiguity | none |
| research | `brief.md`, `knowledge` and `skill-discovery` sockets, the repo and its history | `research.md`, `access-report.json` | none, but it can file new decisions |
| plan | brief and research | `plan/plan.md`, a curator page under `.plans/` | plan gate (hard) |
| implement | the approved plan | commits on branch `sdlc/<run-id>` in a git worktree | none |
| recheck | the diff and the approved plan | `recheck.md` | drift gate, only if the diff diverges from the plan |
| ship | `reviewer` and `verifier` sockets | evidence manifest, pushed branch, draft PR | ship gate (hard) |
| respond | PR comments through sentinel | fixes, replies, an escalation list | you mark the PR ready to arm it |

What each stage does, in more detail:

**intake** fetches the ticket through the socket and writes `brief.md`: goal, acceptance criteria, constraints, unknowns and affected repos. Each unknown becomes a pending decision. Ticket text is treated as untrusted.

**research** fans the question out to every knowledge provider, runs skill discovery, and searches the repo with git history and `gh`. `research.md` marks each finding as known or guessed, lists existing work that could be reused, and includes a blast-radius map of consumers, schemas and events the change touches. A source that cannot be reached is named in the report. It is never silently dropped.

**plan** writes the plan with steps, files touched, a verify command per step, risks and a test strategy. A fresh-context check compares the plan with the brief's acceptance criteria and files any mismatch as a decision. The plan is rendered in curator and you approve it before any code is written.

**implement** works in a disposable worktree and refuses to run in your primary checkout. It uses test-first steps and records the red and green commits. It does not push.

**recheck** compares the diff with the approved plan in a fresh context. Material drift opens a gate where you choose to accept it, go back to plan, or go back to implement.

**ship** runs the reviewer socket and the verifier socket. Findings from the reviewer carry an action: `no-op`, `auto-fix` or `ask-user`. Questions for you are filed word for word. The verifier must return evidence for each claim. Passing unit tests alone does not count. If evidence cannot be gathered, the stage flags the gap and proposes ways to unblock it. It does not mark the claim passed or failed. Then it shows the evidence and asks you before it pushes or opens the PR. The PR is a draft.

**respond** starts only after you mark the PR ready. It runs `sentinel scan` on a delay after each pushed commit, groups findings by root cause, fixes the ones the policy marks `auto_address` in one batched push per cycle, replies to and resolves bot threads, and passes `escalate` findings to you unchanged. It converges when sentinel reports no open blocking finding. It stops at `max_iterations` (10 by default in `config/sentinel/default.json`) and hands you the full round history.

The file layout, status values and decision schema are in `engine/stages/CONTRACT.md`. A fictional ticket traced through every stage is in `engine/stages/WALKTHROUGH.md`.

---

## 4. Daily flows

### 4.1 You have a requirement

```
/clerk <requirement, a link to it, or paste the thread>
```

Clerk checks that it can reach the sources it needs and tells you which are blocked or partial. It researches precedent with `gh` and your tracker and wiki connectors, lists every approach it found with its prior art (or says there is none), and opens an approach gate in curator. After you pick one it drafts the tickets and opens a second gate. It creates tickets only after you approve that set, then hands each key to the engine.

If a ticket already covers the work, clerk compares what is built with what remains. If nothing is missing it passes the key straight to the engine and creates nothing. If part is missing it drafts only the difference.

Clerk loads local team profiles if you have any, so its estimates fit how a team works. Profiles describe colleagues, so they live in `.local/team-profiles/` and are never committed. See `teams/README.md`.

### 4.2 You have a ticket

Say the ticket is GitHub issue `your-org/your-repo#123` and your work repo is `~/code/your-repo`. The built-in `gh-ticket` adapter takes the `owner/name#number` form; a tracker adapter of your own can take keys like `PROJ-123`.

```sh
detent run new --ticket your-org/your-repo#123 --repo ~/code/your-repo   # creates the run and a worktree
detent next --repo ~/code/your-repo                        # prints the next command
```

Every engine command prints one JSON line with a `next_step`. Do what it says, then run `next` again. When `next` reports a pending gate:

```sh
detent gate open <gate-id> --repo ~/code/your-repo
```

With curator installed this writes `.plans/<run-id>-<gate>.html`, a page with one question per pending decision and the plan or research text underneath, and prints a `curator open` command. Answer in the browser, then run `detent gate collect --run <run-id>`. It reads your clicks from curator and writes an answer into `decisions.json` only when it is exactly one of the decision's options. Anything else stays pending and is listed under `unresolved`. Comments you add are saved to `review-feedback.jsonl` in the run directory. Run `detent dashboard` to see every active run with its stage and pending gates.

**Letting the engine drive.** `detent drive --run <run-id>` runs the stages for you with one headless Claude child per stage and stops when it needs your decision, before implement, or when it has spent `--budget` (default 5 USD). In a Claude Code session, `/detent:drive` launches it in the background and walks you through the gate page. `detent drive` is experimental, works on macOS and Linux only, and spends Claude credit. It covers intake, research and plan only; children get file tools and no Bash, so the target repo's hooks and scripts never run. The details are in [engine/cli/README.md](engine/cli/README.md).

### 4.3 You pushed a PR

The autoscan hook runs after `gh pr create`, `gh pr ready` and `git push` on a branch with an open PR. It does two things:

- It asks the session to run **referee** on the PR. This includes drafts.
- If the PR is not a draft, it starts a detached sentinel scanner. Bots rarely review drafts, so draft PRs are skipped for scanning.

The scanner waits about 5.5 minutes, then scans in rounds with a 5-minute gap. It tracks each head commit separately, because bots review every push. Results go to `.local/inbox/<owner>__<repo>__pr<N>/respond-inbox.jsonl`.

```sh
cat "${DETENT_INBOX_DIR:-$DETENT_ROOT/.local/inbox}"/*/respond-inbox.jsonl
node engine/sentinel/sentinel.mjs scan --pr <pr-url> --config config/sentinel/default.json   # manual, read-only
```

Sentinel classifies each bot comment as `auto_address`, `ignore` or `escalate`, using the policies in the config. Any path matching `escalate_globs` always escalates to you.

### 4.4 You are going to sleep

```
/owl <objective>
```

The skill checks that the objective suits an unattended loop and confirms the caps with you. To skip the skill, run the orchestrator directly:

```sh
engine/owl/owl.sh --objective "add unit tests for the parser module" \
  --repo ~/code/your-repo --max-iterations 8 --max-minutes 300
```

Each iteration does one small verifiable step and commits it on branch `owl/<slug>`. A failed iteration is rolled back. The loop stops at the iteration cap, the wall-clock cap, or three failures in a row. When it hits a decision it cannot make, it picks a provisional path, logs it in a decision journal and keeps going. Owl has been tested only against a stub `claude` binary, so treat it as experimental.

In the morning, build the review. You accept or reject each commit, under a banner saying the agent's claims are unverified:

```sh
engine/owl/morning-review.sh ~/code/your-repo/.owl/<run-dir>
```

### 4.5 You want to review something

Plans, comparisons and long reports go to curator. The hooks nudge toward it, or you can say "show it in curator". To open a page yourself:

```sh
curator open .plans/<artifact>.html
curator status
```

Highlight text, annotate elements and click decisions. Your feedback reaches the agent as JSON.

### 4.6 Morning brief

`/herald` or `detent herald` collects what happened since the last brief: owl results, open PRs that need action, active engine runs, and tracker, mail and chat items when those connectors are present. Items are labeled urgent, needs-action or FYI. `herald -3` widens the window to three days. Details are in `docs/morning-brief.md`.

---

## 5. Sockets and providers

The engine contains no knowledge of your tracker, wiki, reviewer or test tooling. Each of those enters through a socket. A socket is a command declared in `stack.yaml`. The engine runs it, writes one JSON request to its stdin, and reads one JSON response from its stdout. stderr is free-form logging.

| Exit code | Meaning | What the engine does |
|---|---|---|
| 0 | success | Reads the JSON. An empty result is still success. |
| 1 | provider failure: network, auth, not found | Retries once with a warning, then shows you the error. |
| 2 | contract violation: bad input, bad setup | Halts the stage and asks you. |

| Socket | Used in | Contract |
|---|---|---|
| `ticket` | intake | `engine/sockets/ticket.md` |
| `knowledge` | research (several providers, merged) | `engine/sockets/knowledge.md` |
| `skill-discovery` | plan | `engine/sockets/skill-discovery.md` |
| `reviewer` | ship | `engine/sockets/reviewer.md` |
| `verifier` | ship | `engine/sockets/verifier.md` |
| `bot-comments` | respond | `engine/sockets/bot-comments.md` |
| `skills-pack` | pipeline assembly | `engine/sockets/skills-pack.md` |
| `incident` | after merge | `engine/sockets/incident.md` |
| `deploy-harness` | explicit request only | `engine/sockets/deploy-harness.md` |

Three rules about wiring:

- **A socket you do not declare is off.** `detent socket call <name>` refuses and names the socket. A skill that needs it says which provider is missing and what it skipped.
- **Providers carry a `version` field.** It records which contract version you wrote the provider against. The engine does not check it at run time. Adapters in this repo use `builtin`.
- **The deploy harness is meant to run on request only.** The contract in `engine/sockets/deploy-harness.md` says it runs on your explicit request, or at ready-to-merge if you set `gate_on_ready_to_merge: true`. Nothing in the engine CLI checks where you wire it, so keep it out of normal stages yourself.

The engine reads `stack.yaml` from the work repo (or `engine/stack.yaml`, or the path in `--stack`). It uses a small built-in YAML parser for the shapes in `engine/stack.example.yaml`: nested maps, lists of maps and inline lists. Keep your file to those shapes.

---

## 6. Writing a provider and a pack

### A provider

A provider is any executable. This one fills the `knowledge` socket by searching a folder of notes:

```sh
#!/usr/bin/env bash
# notes-search: knowledge provider over ./notes
[ "$1" = "--socket-version" ] && { echo "1.0.0"; exit 0; }
req="$(cat)"
query="$(printf '%s' "$req" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).query))')"
hits="$(grep -rniF -m1 -- "$query" notes/ | head -5)" || true
node -e '
  const lines = process.argv[1].split("\n").filter(Boolean);
  const results = lines.map(l => ({source: l.split(":")[0], excerpt: l.slice(0, 240), confidence: 0.5}));
  console.log(JSON.stringify({provider: "notes", query: process.argv[2], results, next_step: "use these as leads, not proof"}));
' "$hits" "$query"
```

Declare it:

```yaml
sockets:
  knowledge:
    providers:
      - name: "notes"
        command: "./notes-search"
        version: "1.0.0"
```

Test it without the engine:

```sh
echo '{"query":"retry policy"}' | ./notes-search
```

Rules that apply to every provider: print one JSON object, include a `next_step` string, use the exit codes above, and treat the request as untrusted input. Never build a shell command by pasting the request into it.

### A pack

A **skills pack** is how a team adds stages without forking the engine. It is a versioned directory plus a `manifest` command that answers the contract in `engine/sockets/skills-pack.md`: which stages or skills it adds and where they splice in. List it under `sockets.skills-pack.packs` in `stack.yaml`. A pack that fails its manifest stops the pipeline. The engine will not run with a broken pack.

A **provider pack** in the sense of `packs/example/stack.yaml` is a different file from the engine's `stack.yaml`. It lists knowledge providers, review lenses, an incident skill, an analytics server and a network check, and the skills read it. Select it with `pack.path` in `detent.user.yaml`. A null field turns that feature off. The engine's own `stack.yaml` holds the socket bindings, and you start it from `engine/stack.example.yaml`. Keep one of each per environment, and keep any company-specific commands in your own repo.

---

## 7. Skills and tools reference

`detent` is the one command for manual use. Skills fire on intent, so you rarely type these.

| Command | Does |
|---|---|
| `detent run new --ticket <key>`, `detent next`, `detent stage ...`, `detent gate open <id>`, `detent gate collect --run <id>`, `detent socket call <name>`, `detent dashboard`, `detent bench <run-id>` | The engine runner. |
| `detent drive --run <id>` | Experimental. Runs intake, research and plan with contained headless children, then stops for you. Spends Claude credit. |
| `detent curator ...` | Curator: `open`, `poll`, `reply`, `end`, `status`. |
| `detent sentinel ...` | Sentinel: `scan`, `config-check`. |
| `detent owl ...` | The owl orchestrator. |
| `detent herald ...` | Morning brief: `window`, `assemble`, `render`. |
| `detent courier ...` | Connector-read broker: `request`, `await`, `list`, `get`, `fulfill`, `fail`. |
| `detent feedback ...` | A journal where the agent logs gaps it noticed in its own coverage. |
| `detent eval ...` | The eval harness. |

**Drive (experimental).** `detent drive --run <id>` runs intake, research and plan for you with one headless `claude -p --restricted` child per stage, then stops at the plan gate, at any decision, or at `before_implement`. It never implements or ships: you run those stages yourself, interactively. Each child gets file tools only (no Bash, no MCP, no web) on a read-only copy of your repo, with a scrubbed environment, and hands its work back through an outbox that drive validates before it writes any run state. The budget is `--budget` USD per invocation (default 5), enforced per child with `--max-budget-usd`; claude can overshoot by one turn. macOS and Linux, Claude Code 2.1.306 or newer. What it contains and what it does not are in `engine/cli/README.md` and [SECURITY.md](SECURITY.md).

**Curator.** Serves self-contained HTML pages on `127.0.0.1` and records annotations and decisions. State is in `~/.curator`. A page may not load external scripts, fonts or images. The curator skill writes the page and runs the feedback loop in a subagent so poll output stays out of the main conversation.

**Sentinel.** Reads PR issue comments and review threads through `gh`, matches the author to a bot entry in the config, parses severity with the bot's patterns, and applies the bot's policy. It tracks which comments it has seen in `~/.sentinel`. It never posts.

**Courier.** A subagent or headless job cannot reach connectors that only an interactive session has. It writes a request into `.local/reads/`. The Stop hook tells the interactive session to read the source and fulfill the request. No credentials are stored.

**Routing and cost.** `engine/routing` holds three model tiers (strong, fast, light) and a convention for consulting a stronger advisor when a stage blocks. It is recommend-only. See `docs/model-routing.md`. `detent spend` and `detent bench` report cost and timing from local logs. See `docs/benchmarking.md`.

**Writing rules.** Every skill that drafts text for a person shares the evidence and voice rules in `docs/evidence-and-voice.md`. If you keep a voice file, point `voice.file` in `detent.user.yaml` at it and the voice hook will name it.

---

## 8. Evals

`detent eval` scores the repo's agent-facing behavior against a committed baseline. It checks skill frontmatter, hook kill switches, curator self-containment and sentinel's comment triage. The deterministic tier makes no network calls. An optional judge tier runs `claude -p` and needs a signed-in `claude` binary.

```sh
detent eval                       # every suite in evals/config.yaml
detent eval --changed             # suites touched by your branch's diff
detent eval --suite sentinel-golden
detent eval --no-judge            # deterministic checks only
detent eval --rebaseline --no-judge   # rewrite evals/baseline.json, then commit it
```

It prints one JSON line on stdout and a plain report on stderr. The verdict is `UPGRADE`, `NEUTRAL` or `DEGRADE`:

- Any deterministic check that passed in the baseline and fails now is a `DEGRADE`.
- A suite score that falls more than the band (0.05 by default) is a `DEGRADE`. One that rises more than the band is an `UPGRADE`.
- Anything else is `NEUTRAL`.

`gate.mode` in `evals/config.yaml` sets whether a `DEGRADE` fails CI. In blocking mode the gate arms only after `burn_in_prs` clean runs against the current baseline. A deterministic flip blocks right away. Exit codes: 0 ran, 1 environment failure, 2 refusal (or a blocking `DEGRADE`). Cases live in `evals/cases/<suite>/*.json`. The full mechanics, including the rebaseline procedure, are in `engine/eval/README.md`.

To add a case, copy a neighbor in `evals/cases/<suite>/`, change its `id`, `check` and `params`, run `detent eval --suite <suite> --no-judge`, and commit the case. Rebaseline once to include it.

---

## 9. The leak gate

Detent is meant to be published and reused, so the repo must not carry names, hostnames or ticket keys from the organization that runs it. `engine/scripts/company-strings-check.sh` greps for a list of strings that you keep.

The list is **your own file**, kept out of git:

```sh
mkdir -p engine/.local
printf '%s\n' 'AcmeCo' 'acme.internal' 'ACME-' > engine/.local/denylist.txt
bash engine/scripts/company-strings-check.sh --repo --paths-only
```

- One fixed string per line. Blank lines and lines starting with `#` are ignored. Matching ignores case.
- By default it scans `engine/`. `--repo` scans the whole repo. `--paths-only` prints file and line but never the matched text, which keeps a secret list out of CI logs.
- `.git`, `.local` and `node_modules` are skipped.
- A missing or empty list exits 2. It is never a silent pass. Exit 1 means a hit, 0 means clean.
- `.leakgate-allow` can list path globs for the scan to skip.

In CI the `leak-gate` workflow writes the list from a repository secret named `LEAK_DENYLIST`. The workflow also runs gitleaks for credentials. A fork pull request has no access to the secret, so the job fails closed instead of passing an unchecked tree. Run the check yourself before you push.

---

## 10. Where things live

| Place | Contents |
|---|---|
| detent clone | Everything in this repo. `engine/` is generic and checked by the leak gate. |
| `.sdlc/<run-id>/` in the clone | One run: `run.json`, `brief.md`, `research.md`, `decisions.json`, `stage-status.json`, `events.jsonl`, `plan/`, `handoff/`, and the `worktree/`. |
| `.plans/` in the clone | Curator pages, gitignored. |
| `.local/` in the clone | Gitignored: `inbox/` (sentinel rounds per PR), `team-profiles/`, `reads/` (courier), `brief-state.json`. |
| `detent.user.yaml` | Your personal values, gitignored. |
| `stack.yaml` | Your socket bindings, in the work repo or passed with `--stack`. |
| `.owl/` in a work repo | Owl logs, notes and lock. Never committed by the loop. |
| `~/.curator`, `~/.sentinel` | Curator sessions and sentinel's seen-comment list. |

`DETENT_ROOT` sets where `.sdlc/` and `.plans/` live. When it is unset, the engine uses the clone it runs from. Override paths with `DETENT_INBOX_DIR`, `DETENT_COURIER_DIR` and `DETENT_TEAM_PROFILES`. Run `scripts/migrate-local-state.sh` once if you have state from an older `~/.detent` layout. It copies and never deletes.

---

## 11. When something goes wrong

**Curator does not open.** Check `command -v curator`. If it prints nothing, run `(cd engine/curator && npm link)`. In the meantime `gate open` prints a terminal fallback with the question, the options and how to edit `decisions.json`.

**A hook does not fire.** Confirm the plugin is installed and restart Claude Code. The curator hooks turn themselves off when `curator` is missing and in background jobs. For autoscan, `SENTINEL_AUTOSCAN=off` disables it, and a draft PR is skipped on purpose. The per-PR log is `.local/inbox/<owner>__<repo>__pr<N>/sentinel-autoscan.log`. A failed scan round writes a `sentinel_scan_error` line instead of vanishing. Test the mechanics without waiting by using the recipe in `hooks/README.md`.

**The engine refused my command (exit 2).** Exit 2 is a contract refusal such as an illegal stage transition, a missing artifact or a pending gate. The JSON has a `reason`. Running `detent next` prints the command that unblocks you.

**A skill says a provider is missing.** The socket it needs is not declared in your `stack.yaml`. Add a provider for it, or accept that the skill will skip that source. The skill tells you what it skipped.

**Research is thin.** A knowledge source that is unreachable is named in `access-report.json` and in the brief. Fix access to that source, or add another provider, and re-run research.

**`gh` errors.** Run `gh auth status`. Sentinel, herald and the PR hooks need a signed-in `gh` with read access to the repo.

---

## Worked example

A complete run on a small public repo is coming. It will be run from scratch, and the whole `.sdlc/<run-id>/` directory will be committed so you can read each brief, plan, decision and evidence file. Until then, `engine/stages/WALKTHROUGH.md` traces a fictional ticket through every stage.
