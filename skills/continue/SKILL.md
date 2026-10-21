---
name: continue
description: >-
  Use when the user says to continue, resume or take the next step of a detent run.
  Runs the current stage in this session and stops at any gate for the user.
allowed-tools: >-
  Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs continue *), Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs continue), Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs decide *), Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs decide), Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs status), Read
---

# /detent:continue — run the next stage here

## Step 1. Ask detent what is next

```
node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs continue
```

`CLAUDECODE` is set in this session, so `detent continue` starts no other Claude. It
prints the run id, the stage and the path of that stage's `SKILL.md`.

## Step 2. Run the stage in this session

Read the `SKILL.md` at the printed path and follow it for that run id. Do the stage
yourself, here. Do not start `detent drive` or another `claude`.

## Step 3. Stop at a gate

If `continue` prints `waiting`, or the stage opens a gate, a person has to answer.
Present it with:

```
node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs decide
```

or with curator, using the gate page the stage printed. Then wait for the user's
answer. Never answer a gate yourself. `detent approve` and `detent revise` refuse
inside Claude Code on purpose, so do not look for a way around them, and never write
`decisions.json` by hand.

## Step 4. Report

Say which stage finished and what is next. When the user is ready, they run
`/detent:continue` again. At any time `/detent:status` shows where the run stands.
