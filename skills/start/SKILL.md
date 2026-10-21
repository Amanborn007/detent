---
name: start
description: >-
  Use when the user wants to begin work on a GitHub ticket, such as "start
  your-org/your-repo#123" or "work on this issue". Creates a new detent run.
argument-hint: "<owner/repo#N>"
allowed-tools: >-
  Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs start *), Read
---

# /detent:start — begin a run for one ticket

This starts a run. It does not write the brief or any code. Run it from a clone of the
ticket's repo, because `detent start` refuses when `origin` is a different repo.

## Step 1. Get the ticket

You need one argument in the form `owner/repo#N`. If the user gave a URL or a bare
number, ask for the `owner/repo#N` form. Do not guess the owner.

## Step 2. Start the run

```
node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs start <owner/repo#N>
```

It checks `origin`, runs `detent setup` if `stack.yaml` is missing, and creates the run
and its worktree. Read the one JSON line it prints.

## Step 3. Report and hand over

If `ok` is true, say the run id and tell the user to run `/detent:continue` for the
intake stage. If it refuses, say the `reason` and the `next_step` as printed. Do not
retry with other flags.
