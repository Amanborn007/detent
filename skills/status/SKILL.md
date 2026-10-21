---
name: status
description: >-
  Use when the user asks where a detent run stands, what is waiting on them, or
  what to do next. Read-only.
allowed-tools: >-
  Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs status *), Bash(node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs status), Read
---

# /detent:status — where the run stands

This changes nothing. Run it in the repo the run belongs to.

```
node ${CLAUDE_PLUGIN_ROOT}/engine/cli/detent.mjs status
```

Detent finds the newest unfinished run for the repo you are in. To pick another, add
`--run <run id or ticket>`. If two runs match, it refuses and lists them. Ask the user
which one.

Report the stages, any gate waiting on the user, and the printed `next_step`, in plain
words. If a gate is waiting, tell the user to answer it with `/detent:continue`, which
opens it for them. Do not answer it yourself.
