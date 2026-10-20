---
name: drive
description: >-
  Experimental. Run a detent run end to end with headless Claude children, one
  per stage, and stop only when you need to decide something. Spends Claude credit.
disable-model-invocation: true
allowed-tools: >-
  Bash(*/engine/cli/detent.mjs*), Bash(detent *), Bash(curator open*),
  Bash(tail *), Bash(cat *), Read, AskUserQuestion
---

# /drive — run a run end to end (experimental)

`detent drive` spawns one `claude -p` child per stage, using the stage skill under
`engine/stages/`. It stops for a human decision, before ship, at the step cap, at
the budget, or on a failure. It spends Claude credit (default cap 5 USD per
invocation) and it runs the target repo's own `.claude/settings.json` hooks, so
only drive repos you trust. macOS and Linux only.

Resolve the CLI relative to this skill:

```
${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-<skill-dir>/../..}}/engine/cli/detent.mjs
```

## Step 1 — confirm before spending

You need a run id (`detent dashboard` lists runs) and the repo path. Tell the user
the budget (`--budget`, default 5 USD) and the model (`--model`, default
`claude-sonnet-5-5`) and get a yes before launching.

## Step 2 — launch in the background, never in the foreground

A drive can run for far longer than the Bash tool's 10 min foreground cap, which
would kill it mid-stage. Launch it with the Bash tool's `run_in_background: true`:

```
node <cli> drive --run <id> --repo <repo> [--budget <usd>] [--max-steps <n>]
```

This is `detent drive --run <id> --repo <repo>` with the CLI path spelled out.

Never run it in the foreground. You are told when the background command exits.
Do not poll its output while it runs. `events.jsonl` in the run directory shows
progress if the user asks.

## Step 3 — report the last JSON line

When it exits, read the last line of its output. It is one JSON object with a
`stopped` field (or `done: true`). Report it plainly, with `total_cost_usd`:

- `needs_human`: open the gate page with `curator open <html>` (the `html` field),
  tell the user to click their answer in the browser and say when they are done.
  Then run `detent gate collect --run <id>`, and launch drive again as in step 2.
- `before_ship`: the run is ready to ship. Tell the user, and relaunch with
  `--allow-ship` only if they ask. Push and PR creation stay blocked for the child
  even then.
- `budget` or `max_steps`: say how far it got and offer to continue with a higher
  `--budget` or `--max-steps`.
- `child_answered_decision`: a child tried to answer a decision itself. It was
  reverted. Show the `detail` and do not relaunch until the user has looked.
- any other failure (`no_progress`, `child_timeout`, `child_failed`, `child_error`,
  `child_no_cost`): show `reason`, `detail` and `stderr_tail`. Do not retry blindly.

Answers to decisions come only from the user. Never write `decisions.json` yourself.
