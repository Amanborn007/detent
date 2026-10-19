# Morning brief

**Takeaway: one command, one interactive session, one actionable artifact.**
`detent herald` gathers everything that happened since your last brief, groups it by
urgency, and renders a single curator card wall where each item can kick off a
dedicated run. It runs in your interactive session — that is the only place the
Jira / Gmail / Slack connectors are reachable.

## What it covers

The window is always **`last_window_end -> now`**, read from
`${DETENT_ROOT}/.local/brief-state.json`. Miss a day (weekend, leave, sick) and
the next brief simply spans the wider gap — there is no hardcoded "yesterday".

| Section | Source | Reachable headless? |
|---|---|---|
| Overnight work | owl results in `.owl/<run>` (with provisional decisions) | yes |
| Open PRs needing action | `gh` (changes-requested, failing checks, unresolved bot comments) | yes |
| Active engine runs | the `.sdlc` dashboard (current stage, pending gates) | yes |
| Jira assigned today | Atlassian MCP | **no — interactive-only** |
| Mail to read | Gmail MCP | **no — interactive-only** |
| Slack mentions & threads | Slack MCP | **no — interactive-only** |

Every item is tagged **urgent** (something is wrong / blocking now),
**needs-action** (a decision or action only you can take), or **FYI**.

## The honest constraint (why it is not a headless cron job)

A headless cron **cannot** produce the full brief:

- Jira, Gmail, and Slack are **interactive-only claude.ai connectors**. A
  background/headless run does not have them in its tool inventory — the tools
  are simply absent, and no retry fixes that.
- A cron also cannot open a browser to show you the artifact when you are away.

So the design is **one consolidated interactive action**, not a split
prep-then-render:

1. **A trigger, not a data job.** The `SessionStart` hook
   (`hooks/morning-brief-session.sh`) checks `brief-state.json` at the start of
   each session. If no brief has run yet today, it injects a one-line nudge and
   the agent offers to run it. It never gathers data, never calls a connector,
   never opens a browser.
2. **The brief runs in that interactive session.** `detent herald` assembles the
   machine-computable sections, the agent fills the connector sections via the
   (now reachable) MCP connectors, and it renders the artifact.

An optional macOS notification (`engine/herald/install-notify.sh`) can nudge you
at a set time each morning to *open a session* — it too only reminds; it never
assembles data.

## How to run it

```sh
detent herald                # or invoke the herald skill: "brief me" / "/brief"
```

Under the hood (the herald skill drives these; you rarely type them):

```sh
detent herald assemble                       # machine-computable core -> brief-data-<date>.json
#   ...agent runs the access-preflight for tickets/mail/chat and fills them...
detent herald render <brief-data-<date>.json # one curator artifact + records the run ts
detent curator open  .plans/morning-brief-<date>.html   # main session owns the curator loop
```

- `detent herald window` prints the window that would be covered (debugging).
- `detent herald render --no-record` renders without advancing the state (dry run).
- `detent herald render --carry <json-array-file>` carries deferred items forward.

## Acting on an item

Choosing **Act** on a card returns a structured decision; the agent then kicks
off a **dedicated run** for that item — the brief is a dispatcher, not where the
work happens:

| Item | Act → |
|---|---|
| PR | `detent sentinel <pr-url>` (sentinel) or `detent run new --ticket <pr-url>` (respond stage) |
| Ticket | clerk, or `detent run new --ticket <KEY>` |
| Mail / Slack thread | a drafted reply via the connector (`create_draft` / `slack_send_message_draft`) |
| Engine run | `detent gate open <gate> --run <id>` if blocked, else `detent next --run <id>` |
| Owl run | open its morning-review artifact to accept/pivot provisional decisions |

**Snooze** carries an item to the next brief; **Dismiss** drops it. Snoozed items
and a short "what I kicked off" note become the next brief's *Context from last
brief*, so consecutive briefs stay continuous.

## Access & data completeness

If a connector is not authenticated in your session, the access-preflight
(`engine/sources/PREFLIGHT.md`) marks it `blocked` and the artifact's **Access &
data completeness** panel shows the exact enable action ("authenticate the Gmail
connector", etc.). A blocked source is never silently omitted or guessed.

## State & files

| Path | What |
|---|---|
| `${DETENT_ROOT}/.local/brief-state.json` | `{last_run_ts, last_window_end, carry_context[]}` — gitignored local state |
| `${DETENT_ROOT}/.local/brief-data-<date>.json` | the assembled brief-data (input to render) |
| `${DETENT_ROOT}/.plans/morning-brief-<date>.html` | the rendered curator artifact |

## Tests

```sh
node --test engine/herald/test/     # window, urgency, assembly, connector-pending, state
node --test engine/cli/tests/      # includes the detent herald route
```
