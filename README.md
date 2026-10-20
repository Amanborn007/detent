# detent

[![test](https://github.com/Amanborn007/detent/actions/workflows/test.yml/badge.svg)](https://github.com/Amanborn007/detent/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Detent is a Claude Code plugin that walks a ticket to a draft pull request in gated stages, and stops for a human at every decision.

You give it a requirement or a ticket key. It researches, plans, implements, rechecks, ships a draft PR and handles the bot comments that arrive afterwards. Each stage ends at a gate. A gate is a decision you answer in a local browser page called curator, not in a wall of terminal text. Detent never merges. Creating tickets, the first push and the draft PR each wait for your approval.

Detent is two kinds of parts:

- **Skills** are prompts that Claude loads when your intent matches, or when you type a slash command. They do the judgment work: research, drafting, summarizing.
- **Tools** are small Node and shell programs (`engine`, `curator`, `sentinel`, `owl`, `detent`). They hold the state machine, the gates and the scans, so those run the same way every time.

Your tracker, knowledge sources, reviewer and verifier are not built in. They plug in through **sockets**, which are command-line contracts you declare in a YAML file. The engine itself names no company and no vendor.

![detent demo](docs/demo/demo.gif)

## Quickstart

This takes about five minutes. You need Claude Code, Node.js 20, `git`, `bash` and a signed-in `gh` (see [Requirements](#requirements)).

1. Install the plugin. Inside Claude Code, then restart it:

   ```
   /plugin marketplace add Amanborn007/detent
   /plugin install detent@detent
   ```

2. Clone the repo and run the install script once. It puts `curator`, `engine` and `detent` on your `PATH` and creates `detent.user.yaml`. Open a new shell afterwards.

   ```sh
   git clone https://github.com/Amanborn007/detent && cd detent
   scripts/detent-install.sh
   ```

3. Point detent at the repo you want to work on. Copy `engine/stack.example.yaml` to `stack.yaml` in that repo. Keep only the `ticket`, `knowledge` and `bot-comments` sockets and set them to the built-in adapters, each with `version: "builtin"`. These work with a GitHub issue and need no other service:

   - `ticket`: `engine/adapters/gh-ticket`
   - `knowledge`: one provider, `engine/adapters/repo-docs-knowledge`
   - `bot-comments`: `engine/adapters/gh-bot-comments`

   Write these `command` values as absolute paths into your clone. The engine resolves a relative path from the directory that holds `stack.yaml`, which is your work repo, not the clone.

4. Start a run on one GitHub issue. The built-in ticket adapter takes `owner/name#number`:

   ```sh
   detent run new --ticket your-org/your-repo#123 --repo ~/code/your-repo
   detent next --repo ~/code/your-repo
   ```

   Every command prints one JSON line with a `next_step`. Do what it says and run `next` again. When `next` reports a pending gate, run `detent gate open <gate-id> --repo ~/code/your-repo` and answer it in curator. The run stops at the plan gate before any code is written, and again at the ship gate before the first push and the draft PR.

[GUIDE.md](GUIDE.md) covers each stage and gate in detail.

## What it does

The engine runs seven stages. They group into four phases, and each phase ends at a gate you answer.

| Phase | Stages | What happens |
|---|---|---|
| Explore | intake, research | Fetch the ticket, write a brief, search your knowledge sources and the repo, write `research.md` with a map of what the change could break. |
| Plan | plan | Write the plan, check it against the brief in a fresh context, and render it in curator. You approve it before any code is written. |
| Code | implement, recheck | Commit on a ticket-named branch in a disposable git worktree, using test-first steps. Then diff the result against the approved plan and file any drift as a decision. |
| Commit | ship, respond | Run review and verification through your sockets, stop at a ship gate, push, and open a draft PR. The respond loop starts only after you mark the PR ready. It then triages bot comments on every push. |

Run state lives in plain files under `.sdlc/<run-id>/`. You can read every one of them.

### Skills

| Skill | Trigger | What it does |
|---|---|---|
| clerk | `/clerk <requirement or ticket key>` | Turns a requirement in any shape into researched tickets. It lists the approaches with precedent, asks you to pick one, drafts the tickets, and creates them only after you approve. Given an existing ticket key, it compares what is built with what remains and creates only the missing delta. |
| referee | automatic on push, or `/referee` | Reviews a PR diff. On your own PR it proposes fixes behind an approval gate. On someone else's PR it only drafts comments. Nothing is posted without your approval. |
| scout | automatic in the research stage | Sends one question to every knowledge provider you have wired in, plus the repo's own docs, and returns one ranked brief with the source of each claim. |
| scribe | `/scribe` | Reads a thread (Slack, email, Jira, GitHub, Confluence) and recent history on that channel, then drafts a reply in the format that surface needs. It never sends. |
| herald | `/herald` or `detent herald` | Builds the morning brief: owl results, open PRs that need action, active engine runs, and tracker, mail and chat items if those connectors are available. It is rendered as a curator page. |
| owl | `/owl <objective>` | Starts an unattended loop in a separate shell process. It confirms the caps with you first, then commits one small verified step per iteration and stops at a hard limit. |
| curator | automatic for long output | Renders a plan, comparison or report as a self-contained HTML page and reads your annotations and decisions back as JSON. |
| sentinel | automatic after a push | Reads every bot comment on a PR and sorts each one into auto-address, ignore or escalate, according to a JSON policy file. It only reads. It never posts or replies. |
| courier | automatic, or `detent courier` | Lets a headless step ask for data that only an interactive session can reach (for example a chat or drive connector). Your interactive session reads it and hands it back. Detent stores no credentials for this. |
| deslop | `/deslop [PR]` | Reviews your own diff for AI-written slop: restating comments, defensive try/catch on trusted paths, casts to `any`, and style drift. It proposes removals and never edits on its own. |
| examiner | `/examiner <subject>` | Asks you every open question about a plan in one curator round. Each question carries a recommended answer and what breaks if it is wrong. Only you can invoke it. |

Sentinel is implemented as a tool and a hook, not a skill. It is listed here because it sits in the same loop.

## Install

Detent installs from its own plugin marketplace. Inside Claude Code:

```
/plugin marketplace add Amanborn007/detent
/plugin install detent@detent
```

The marketplace name and the plugin name are both `detent`, from `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`. Restart Claude Code after installing.

The plugin gives you the skills and the hooks. It cannot put programs on your `PATH` or export an environment variable. For that, clone the repo and run the shell script once:

```sh
git clone https://github.com/Amanborn007/detent && cd detent
scripts/detent-install.sh
```

The script links `curator`, `engine` and `detent` onto your `PATH`, adds `DETENT_ROOT` to your shell profile, and copies `detent.user.example.yaml` to `detent.user.yaml`. It does not edit `~/.claude/settings.json`. It is safe to run again.

To check the result:

```sh
node engine/cli/engine.mjs help     # prints a usage line as JSON, exits 0
curator status                      # an empty list is correct on a fresh install
```

To update, run `detent-upgrade`. It fast-forwards the clone, re-links the programs and updates the plugin. The plugin cache and the clone are separate copies, so both have to move to the same commit.

## Requirements

- Claude Code with plugin marketplace and hook support. No minimum version is pinned yet.
- Node.js 20.
- `git` and `bash`.
- The GitHub CLI (`gh`), signed in with `gh auth login`. Sentinel, referee, herald and the PR-aware hooks use it.
- Optional: connectors for your tracker, mail and chat. Clerk, scribe and herald use whichever ones your Claude Code session already has.

## Configuration

There are three files.

**`detent.user.yaml`** holds values that belong to you: name, email, GitHub login, your teams, your tracker account, a path to a file of writing-voice rules, and the GitHub org that clerk searches for precedent. Copy it from `detent.user.example.yaml`. It is gitignored. If you leave the GitHub login empty, detent reads it from `gh api user`.

**`stack.yaml`** tells the engine which programs fill each socket. The template is `engine/stack.example.yaml`. Copy it to `stack.yaml` in your work repo (or pass `--stack <path>`) and replace the commands with your own.

**A provider pack** tells the skills which knowledge providers and review lenses you have. The example is `packs/example/stack.yaml`, and `pack.path` in `detent.user.yaml` selects it. Despite the name, it is a different file from `stack.yaml`.

The sockets are:

| Socket | Used by | What the provider does |
|---|---|---|
| `ticket` | intake | Fetch a work item and return normalized JSON. |
| `knowledge` | research | Search one source. You can list several. The engine merges the results. |
| `skill-discovery` | plan | Find skills or playbooks that apply to the task. |
| `reviewer` | ship | Return extra findings, each with an action and a risk level. |
| `verifier` | ship | Run tests and capture end-to-end evidence. A pass with no evidence is rejected. |
| `bot-comments` | respond | List PR comments and tag bot or human. |
| `skills-pack` | assembly | Add stages from a team-owned pack. |
| `incident` | after merge | Read-only investigation hook. |
| `deploy-harness` | on request only | Deploy to a real environment and test there. Never automatic. |

A socket you leave out is off. The engine refuses a command that needs it and names the socket. A skill that depends on one says which provider is missing and what it skipped. It does not guess.

Every provider is a command that reads one JSON request on stdin and writes one JSON response on stdout. Exit 0 is success, 1 is a provider failure (retried once, then shown to you), 2 is a contract violation (the stage stops and asks you). Contracts are in `engine/sockets/`. Reference adapters for GitHub issues, repo docs and GitHub bot comments are in `engine/adapters/`.

**Name a review skill.** In the pack file, `packs/example/stack.yaml`, the `principal` lens has `skill: null`, so referee has no review of record and stops until you set it. Put the name of any PR-review skill you have installed in that field. `/deslop` and `referee --lens deslop` run without it.

Sentinel's bot policies are in `config/sentinel/default.json`. It covers common review bots such as `claude[bot]`, CodeRabbit, Semgrep, Codecov and Dependabot. Copy it and adjust the logins and policies for the bots your org runs.

## What it runs, reads and sends

Detent ships no telemetry. It makes no network call of its own to any detent-run service.

**Hooks.** The plugin registers these through `hooks/hooks.json`. Most of them only add a reminder to the model's context or hold a stop open. Nothing here runs a program that changes your repo.

| Event | Hook | What it does |
|---|---|---|
| SessionStart | `morning-brief-session.sh` | On the first session of a day, adds a one-line nudge to offer the brief. |
| SessionStart, after Write or Edit | `comment-discipline.sh`, `voice-discipline.sh` | Remind the model of your comment and writing rules. |
| After Bash | `sentinel-autoscan.sh` | After `gh pr create`, `gh pr ready` or `git push` on an open PR, starts a detached read-only scanner and asks for a referee review. |
| After Bash | `eval-gate.sh`, `deslop-check.sh` | After a push, remind the model to run `engine eval --changed` or `/deslop`. |
| After ExitPlanMode | `curator-reminder.sh` | Reminds the model to render the approved plan in curator. |
| After Write or Edit | `curator-md-nudge.sh` | Suggests curator when a large markdown file is written. |
| Stop | `curator-pending-feedback-check.sh`, `curator-stop-check.sh` | Keep the turn open when curator feedback is waiting or a review was never rendered. |
| Stop | `courier-autofulfill.sh`, `referee-owed-check.sh`, `sentinel-inbox-check.sh` | Surface pending courier reads, owed PR reviews and unread scanner rounds. |

Set `PR_AUTOREVIEW=off`, `REFEREE_AUTOREVIEW=off` or `SENTINEL_AUTOSCAN=off` to turn off the PR hooks. The hooks that need curator turn themselves off when it is not installed or when the session is a background job.

**Network.**

- `gh` calls to the GitHub API. Sentinel, herald and the autoscan hook use it read-only: pull request state, comments and review threads. The respond stage is the one place that writes without a per-item gate: after you mark a PR ready, it can push fixes and reply to and resolve bot threads, up to the round cap in the sentinel config (10 by default).
- Curator is a local server on `127.0.0.1`. It refuses requests with a non-local `Host` header.
- Owl and the optional eval judge start `claude -p`. That is your own Claude Code install talking to Anthropic under your own login.
- Provider commands in your `stack.yaml` do whatever you wrote them to do.
- Clerk, scribe, herald and courier use the connectors already attached to your Claude Code session. Detent stores no tokens for them.

**What goes where.** Jira, Slack, GitHub and email content is read only through the tools you have connected. Clerk creates tickets only after the ticket gate, referee posts review comments only after you approve the comment plan, and the first push and draft PR wait for the ship gate. Scribe only produces a draft or paste-ready text. The respond loop, described above, is the exception to per-item approval. Thread, ticket and PR text is treated as untrusted data and is never followed as an instruction.

**What it writes on disk.**

| Path | Contents |
|---|---|
| `.sdlc/<run-id>/` in the clone | One run: brief, research, decisions, stage status, event log. |
| `.plans/` in the clone | Curator pages. |
| `.local/` in the clone | Gitignored. Sentinel inbox, team profiles, voice file, courier requests, brief state. |
| `.owl/` in a work repo | Owl logs and notes. Never committed by the loop. |
| `~/.curator`, `~/.sentinel` | Curator session state and sentinel's list of comments it has seen. |

Owl never passes a permission-bypass flag. It runs under a scoped settings profile, owns git itself, rolls back a failed iteration, and stops at the iteration cap, the wall-clock cap (300 minutes by default), or three failures in a row.

## Status

This is early software. Here is what has and has not been checked.

| Part | State |
|---|---|
| `engine`, `sentinel`, `eval`, `herald`, `courier`, `routing`, `spend` | Unit tests in the repo (`node --test`). |
| `curator` | Unit tests in the repo. Some of its server tests need to bind a local port. |
| `owl` | Tested only against a stub `claude` binary. It has not been run against the real one. Treat it as experimental. |
| Hooks | Shell tests in `hooks/tests/`. The autoscan hook has been tested with stubbed `gh` output and not against a live PR in this repo. |
| Skills | Checked by a deterministic eval suite (frontmatter, kill switches, self-contained pages) and an optional model judge. Their behavior in long real sessions is not measured. |
| Stages `plan`, `implement`, `recheck`, `ship`, `respond` | Written as prompts and a state machine. They have not been run end to end on a public project. |
| Provider pack | `packs/example/stack.yaml` is a template. The engine reads it with a small built-in YAML parser that handles only the shapes in the example. |

A worked example is coming. It will be a full run on a small public repo, with the run directory committed so you can read each artifact.

## More

- [GUIDE.md](GUIDE.md): day-to-day recipes, the stage details, writing a pack, evals and the leak gate.
- [engine/README.md](engine/README.md): the sockets and the engine design.
- [hooks/README.md](hooks/README.md): each hook and its environment switches.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
