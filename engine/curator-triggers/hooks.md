# curator trigger hooks

> Engine-internal documentation of the upstream trigger hooks. **Detent adopters:**
> install from the repo's canonical hook set instead — `hooks/README.md` at the repo
> root covers all four hooks (these two, the md-nudge, and sentinel-autoscan) with one
> paste-ready settings.json snippet.

Hook layer that makes curator fire deterministically, independent of whether the model
remembers the standing rule (RULE.md). Two hooks:

| Hook | Event | Purpose |
|---|---|---|
| `exitplan-reminder.sh` | PostToolUse, matcher `ExitPlanMode` | Right after a plan-mode plan is approved, inject a reminder to render it as a curator artifact and start the feedback loop before implementing. |
| `check-curator-used.sh` | Stop | Safety net: if this turn produced a plan/research artifact (a write under `.plans/`, or an approved ExitPlanMode plan) but curator was never opened, block the stop once and tell the model to finish the loop. |

## What this was verified against (local install)

- CLI: `claude` v2.1.201 (`~/.local/bin/claude -> ~/.local/share/claude/versions/2.1.201`).
- Settings structure: read (read-only) from the live user `settings.json` — hooks live under a
  top-level `"hooks"` key, per-event arrays of `{ "matcher": "<ToolName>", "hooks": [ { "type":
  "command", "command": "...", "statusMessage": "..." } ] }`. Existing hooks in this config
  (`hooks/git-guard.sh`, `hooks/pr-autoreview.sh`) confirm the runtime contract: payload JSON on
  stdin; PostToolUse sees `tool_name` / `tool_input` / `tool_response`; hooks emit single-line
  JSON on stdout (`hookSpecificOutput.additionalContext`, `permissionDecision`, ...) or nothing.
- Binary string check (v2.1.201 binary contains all of): `ExitPlanMode`, `hook_event_name`,
  `transcript_path`, `stop_hook_active`, `SessionStart`, `SubagentStop`, `UserPromptSubmit`,
  `"Stop hook prevented"` — so the events and payload fields used below exist in this build.
- Transcript format: real session `.jsonl` files under `~/.claude/projects/` — one JSON object
  per line; assistant tool calls appear as `message.content[] = {type:"tool_use", id, name,
  input}`, results as user-type lines carrying `{type:"tool_result", tool_use_id, is_error?}`.
- NOT verified live: an end-to-end Stop-hook firing inside a real interactive session (that
  needs a live plan-mode session). The scripts themselves are tested against synthetic
  transcripts (`tests/`, 11 cases, all passing) and match the payload contract above.

## Install

1. Copy the two scripts next to the existing hooks:
   ```sh
   cp engine/curator-triggers/exitplan-reminder.sh engine/curator-triggers/check-curator-used.sh ~/.claude/hooks/
   chmod +x ~/.claude/hooks/exitplan-reminder.sh ~/.claude/hooks/check-curator-used.sh
   ```
2. Merge the snippet below into `~/.claude/settings.json`.

## settings.json snippet (paste-ready)

Add the `ExitPlanMode` entry to the EXISTING `"PostToolUse"` array (alongside the current
`"Bash"` matcher entry), and add `"Stop"` as a new key under `"hooks"`:

```json
"hooks": {
  "PostToolUse": [
    {
      "matcher": "ExitPlanMode",
      "hooks": [
        {
          "type": "command",
          "command": "bash ~/.claude/hooks/exitplan-reminder.sh",
          "statusMessage": "Curator reminder"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bash ~/.claude/hooks/check-curator-used.sh",
          "statusMessage": "Checking curator was used"
        }
      ]
    }
  ]
}
```

(`~` expands because hook commands run through the shell; use an absolute path if you prefer
to match the existing entries' style.)

## Hook (a): PostToolUse on ExitPlanMode

`ExitPlanMode` only executes when the plan is APPROVED — a rejected plan denies the tool, so
PostToolUse never fires for rejections. On approval the hook injects
`additionalContext`: *"The plan was just approved - render it as a curator artifact and start
the feedback loop before implementing..."* — the model sees this immediately, before its next
step. Non-blocking; it never alters the tool call. Demo output:

```
$ echo '{"tool_name":"ExitPlanMode","tool_input":{"plan":"1. do X"},"tool_response":{"success":true}}' | bash exitplan-reminder.sh
{"continue":true,"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"The plan was just approved - render it as a curator artifact and start the feedback loop before implementing. ..."}}
```

## Hook (b): Stop-event safety net — feasibility verdict

**Feasible and shipped, with honest limits.** `check-curator-used.sh` reads the Stop payload,
tails the session transcript (`transcript_path`), isolates the current turn (everything after
the last real user prompt — a user line that is neither `isMeta` nor a tool_result carrier),
and compares:

- *artifact produced*: `Write`/`Edit`/`MultiEdit`/`NotebookEdit` with `file_path` matching
  `CURATOR_ARTIFACT_RE` (default `(^|/)[.]plans/`), or an `ExitPlanMode` call with no
  `is_error` result (i.e. an approved plan);
- *curator opened*: `Bash` command matching `CURATOR_INVOKE_RE` (default `\bcurator\b`),
  a `Skill` invocation matching `curator|curator`, or any tool name mentioning curator.

If an artifact was produced and curator never opened, it emits
`{"decision":"block","reason":"..."}` — the model continues and finishes the loop. The
`stop_hook_active` guard means it blocks at most once per stoppage, so it can never wedge a
session. Malformed transcript lines are skipped, and a missing transcript exits 1 with stderr
(non-blocking error) rather than silently passing.

Demo (fake transcript with a `.plans/` write and no curator):

```
{"decision":"block","reason":"A plan/research artifact was produced this turn (or a plan was just approved) but curator was never opened. Render the deliverable as a self-contained HTML artifact under .plans/, open it with curator, and start the feedback poll loop now. ..."}
```

### Known limits (why this is a net, not the primary mechanism)

1. **Text-only deliverables are invisible.** If the model dumps a research report as chat text
   without writing any file, there is nothing greppable in the transcript to distinguish it
   from ordinary conversation. Only RULE.md + the skill description cover that path. Do not
   expect this hook to catch it.
2. **Transcript-format coupling.** The parser matches the v2.1.201 transcript shape (verified
   against real session files). A future format change degrades it to "never blocks" (the jq
   selects simply stop matching) — it fails open, not closed.
3. **Tail window.** Only the last `CURATOR_CHECK_TAIL` (default 2000) transcript lines are
   scanned; a monster turn could push the turn start out of the window (then: fails open).
4. **One nudge only.** By design (`stop_hook_active` guard) the model can stop on the second
   attempt even if it still ignored curator.

**Recommendation: enable it.** It is cheap (one jq pass over a tail), fails open on every edge
case, and deterministically catches the common failure — plan/research artifact written, loop
skipped. Tests: `tests/test-check-curator-used.sh` (11 cases: block/allow, loop guard,
turn-boundary, rejected plans, garbage lines, missing transcript). Manual demo: `tests/demo.sh`.
