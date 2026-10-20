# Detent

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-c8501a.svg)](https://code.claude.com/docs/en/plugins)
[![Version](https://img.shields.io/badge/version-0.11.0-informational.svg)](.claude-plugin/plugin.json)

**Hand Claude Code a ticket. Get back a draft PR you approved twice.**

Left alone, an agent can spend an hour building the wrong thing and then push it. Detent stops it twice. It researches the ticket and writes a plan, then waits for you. It builds in a worktree, checks the diff against the plan you approved, then waits again before it pushes. It never merges.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/detent-architecture-dark.png">
    <img alt="Detent architecture: you work in a Claude Code session whose skills and hooks drive the Detent engine; the engine keeps run state in plain files, renders gates to a local curator page for your approval, and reaches GitHub and your tracker through configured providers, while sentinel watches PR bot comments." src="docs/assets/detent-architecture.png" width="880">
  </picture>
</p>

## What you get

- **Two gates, no surprise pushes.** You approve the plan and you approve the push. Nothing in the repo calls `gh pr merge`.
- **Plans you click, not scroll.** A plan opens as a local web page. You click approve or revise and leave notes on lines, and your answer goes back into the run.
- **Bot comments handled.** Once a PR is ready, sentinel reads what the review bots left and fixes the ones your policy allows, for up to 10 rounds.
- **Your stack, plugged in.** Your tracker, docs, reviewer and test runner are commands in a YAML file, JSON in and JSON out. GitHub adapters ship in the box.
- **Work while you sleep.** `/detent:owl` loops toward an objective overnight, under caps you confirm first.

## Try it in two minutes

You need Node 20, `git`, `jq`, `python3` and a signed-in `gh`. In Claude Code:

```
/plugin marketplace add Amanborn007/detent
/plugin install detent@detent
```

Then put the CLI on your `PATH`:

```sh
git clone https://github.com/Amanborn007/detent && cd detent
scripts/detent-install.sh
```

Open a new shell, go to any branch with changes, and run this in Claude Code. It needs no config:

```
/detent:deslop
```

It reads your own diff and lists the comments, defensive try/catch blocks and `any` casts it would remove. It changes nothing until you say yes.

## How a run works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/detent-pipeline-dark.png">
    <img alt="Detent stage pipeline: intake, research, plan, implement, recheck, ship and respond, with your approval required at the plan gate and the ship gate, and the respond loop driven by sentinel scans." src="docs/assets/detent-pipeline.png" width="880">
  </picture>
</p>

Seven stages. A run lives in plain files, including the brief, the research, the plan and every decision, so you can read what the agent decided and why. The engine refuses to start a stage before the earlier ones are done, and refuses to finish one whose required file is missing.

```sh
detent run new --ticket owner/repo#12 --repo ~/code/your-repo
detent next --repo ~/code/your-repo
```

## The skills

| Skill | What it does |
|---|---|
| `referee` | Reviews a PR. On yours it plans fixes, on someone else's it drafts comments. Posts nothing until you approve. |
| `deslop` | Finds AI slop in your own diff. |
| `clerk` | Turns a loose requirement into approved tickets. |
| `scout` | Researches a question across your docs and repos and returns one ranked brief. |
| `examiner` | Interviews you about a plan until no open question is left. |
| `curator` | Shows any plan or comparison as a clickable page. |
| `owl` | Runs the loop unattended overnight. |
| `herald` | Your morning brief: PRs, runs and overnight results on one page. |
| `scribe` | Drafts a short reply to a Slack, email, Jira or GitHub thread. It never sends. |
| `courier` | Fetches connector data for steps that cannot reach it. |

Type them as `/detent:<skill>`.

## Status

Early, v0.11.0. Most of it waits for you, but a few hooks run on their own, for example a review prompt after `git push`. [What runs without asking](docs/REFERENCE.md#what-runs-without-asking-you) lists every one and its kill switch. The stages have not yet run end to end on a public project, and a worked example is coming.

## Read more

- [docs/REFERENCE.md](docs/REFERENCE.md) has configuration, hooks, security, evals and troubleshooting.
- [GUIDE.md](GUIDE.md) walks through daily flows and writing your own provider.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Inspired by Kun Chen's MIT-licensed no-mistakes, lavish-axi and gnhf. No code was copied, see [NOTICE](engine/NOTICE.md). Licensed under [Apache 2.0](LICENSE).

If Detent saves you a bad push, a star helps other people find it.
