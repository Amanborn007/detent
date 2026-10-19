---
name: herald
description: >-
  Your day since the last brief, as one curator artifact. A trailing number
  widens the lookback, so `herald -3` covers three days.
disable-model-invocation: true
allowed-tools: >-
  Bash(*/engine/herald/*), Bash(*/engine/cli/detent.mjs*), Bash(detent *),
  Bash(git status*), Bash(gh *), Read, Write, Edit, AskUserQuestion, Agent
---

# /brief — the morning brief

**Takeaway: one command, one artifact, one interactive session.** You compute the
since-last-run window, gather every source, render ONE actionable curator
artifact grouped by urgency, and act on each item by kicking off a dedicated run.
There is no headless pre-step — this whole procedure runs in the interactive
session, because that is the only place the Gmail / Slack / Jira connectors are
reachable.

The deterministic core is `engine/herald/herald.mjs` (routed as `detent herald`). You
drive it; you fill the connector sections it cannot reach; you own the curator
loop.

Resolve the CLI relative to this skill (works wherever detent is checked out):

```
${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-<skill-dir>/../..}}/engine/cli/detent.mjs
```

## Why it is one interactive action (the honest constraint)

- `gh`, the local `.owl` results, and the `.sdlc` run state are reachable
  from anywhere — a machine can read them.
- Jira (Atlassian MCP), Gmail (Gmail MCP), and Slack (Slack MCP) are
  **interactive-only claude.ai connectors**. A headless cron cannot reach them
  and cannot open a browser when you are away.
- So the brief is NOT split into a headless prep job + a later render. It runs
  once, in your first interactive session, and does everything. A scheduler only
  *nudges* you to open a session (see `docs/morning-brief.md`); it never
  assembles data headlessly.

## Shape of the brief

The brief is a curator artifact, so it inherits the curator stack rather than inventing a layout:
the theme in [`engine/curator/theme.html`](../../engine/curator/theme.html), the blocks in
[`blocks.md`](../../engine/curator/blocks.md), and the **track** recipe in
[`recipes.md`](../../engine/curator/recipes.md) — what needs you now, what moved since the last
brief, what is blocked and on whom, the rest in an expander. Run
`curator check <artifact>` before opening it — `curator open` runs the same gate
and refuses to serve an artifact that fails it.

Language is [`docs/evidence-and-voice.md`](../../docs/evidence-and-voice.md). The rule that
bites hardest here: **say the state in the sentence, never a coloured tag.** A brief is where status
pills breed.

## Procedure

### 1. Assemble the machine-computable core

```sh
detent herald assemble           # window = last_window_end -> now
detent herald assemble --days 3   # force the past 3 days (the `herald -3` param)
```

**Lookback param (`herald -N`).** When the trigger carries a number
(`herald -3`, `brief me for the last 7 days`), pass it as `--days N`. That
forces the window to exactly the past N days, ignoring the persisted anchor
(`window.forced: true`); the artifact header shows the widened span. Without it,
the window is the normal `last_window_end -> now`.

This computes the window (`last_window_end -> now` from
`${DETENT_ROOT}/.local/brief-state.json`; a multi-day gap just widens it — never
hardcode "yesterday") and fills three sections: **overnight owl work**
(from `.owl/<run>` results in the window, with provisional decisions flagged),
**open PRs needing action** (via `gh` — changes-requested, failing checks, or
unresolved bot comments), and **active engine runs** (the `.sdlc` dashboard). The
brief's machine core also reads `.local/self-feedback/journal.jsonl` and surfaces
new-in-window entries as one **fyi** rollup section (`engine/self-feedback/CONTRACT.md`
— not curator feedback). It writes `brief-data-<date>.json` and marks the connector
sections (`tickets` / `mail` / `chat`) as `pending-interactive`.

### 2. Run the access-preflight for the connector sections

Follow [`engine/sources/PREFLIGHT.md`](../../engine/sources/PREFLIGHT.md). For
each of tickets / mail / chat, probe the connector by a cheap tool-inventory
check: is the MCP tool present in this session's inventory?

- **Present** → reachable; fill it in step 3.
- **Absent** → `blocked`. Record why (`connector-unauthenticated` /
  `interactive-only-context`) and the enable action ("authenticate the <X>
  connector"). Never fire a real call into the void and hang.

Write the outcome into each pending section's record (`status`,
`blocked_reason`, `enable_action`) so the artifact's "Access & data completeness"
panel shows the exact enable action per unreachable source.

### 2b. Large windows: chunk, memoize, and fan out per-source (scale)

A wide window (`--days 7`) or a busy inbox can be a very large read — dozens of
mail threads, long Slack histories, many Jira updates. Do NOT try to read it all
into this context at once; you will blow context and silently miss items. Instead:

- **Memoize with `detent herald seen`.** Before building items for a source, pass the
  candidate ids through the read-cache so you only surface what you have not
  triaged in a prior brief (critical for overlapping/`--days N` windows):

  ```sh
  detent herald seen mail --ids 19f3...:t1720,19eb...:t1699   # -> {fresh:[...], already:[...]}
  ```

  Build items ONLY for the returned `fresh` ids. This is idempotent — re-running
  the brief will not re-raise items you already saw. Cache lives at
  `${DETENT_ROOT}/.local/brief-read-cache.json`, keyed `"<source>:<id>"`.

  **Key mutable sources by id + change-token.** The memo assumes an id is
  immutable. A mail/Slack thread or a Jira issue can get a NEW reply / reopen and
  must resurface. So for those sources append a change token to the id —
  `"<threadId>:<lastMessageTs>"`, `"<ISSUE-KEY>:<updatedAt>"` — so a changed
  thread is a new (fresh) key while an unchanged one stays suppressed. Use the
  bare id only for genuinely immutable things (a merged PR, a fired alert).

  Caveat: `seen` marks ids the moment you call it (not at render). Call it as
  late as you can — right before you build the items you will actually keep — so a
  crash between the gate and the render doesn't bury un-delivered ids.

- **Chunk.** Page the connector (`pageSize`/`cursor` for Gmail, `cursor` for
  Slack, JQL paging for Jira). Process one page at a time: list ids → `seen` gate
  → summarize the fresh ones → append items → next page. Never assume one page is
  the whole window; page until the connector says there are no more.

- **Fan out per-source subagents for the heavy, INDEPENDENT reads.** The three
  sources are independent, so their reads parallelize. BUT mind the reachability
  split (the honest constraint above):
  - **Headless-reachable sources** (owl logs, `gh` PR diffs, `.sdlc`) —
    spawn a subagent per source; each does its own noisy reading and returns only
    a compact list of `{id, title, detail, urgency, action}` items.
  - **Interactive-only connectors** (Gmail / Slack / Jira) — background subagents
    CANNOT reach these; the connector fetch must happen in THIS session. For scale,
    do the *fetch* here (paged + `seen`-gated) but delegate the *summarization* of
    each large raw thread to a subagent (pass it the fetched text, get back a
    one-line item). That keeps bulk text out of the main context without pretending
    a subagent can reach the connector.

  Return summaries, not raw dumps — the main thread stays clean and nothing is
  dropped on the floor.

### 3. Fill the reachable connector sections (interactive reads)

For each reachable connector, read only what the window needs and append items
to that section in `brief-data-<date>.json` (use the item shape the machine
sections already use: `{id, title, detail, source, urgency, signals, action}`).
Tag urgency with the same rules — @-mention / assigned-today / needs-reply =
`needs-action`; overdue = `urgent`; everything else `fyi`. Give every item a
resource `url` in its `action` (the PR/Jira/thread link) so the card is
click-through verifiable — the renderer now surfaces it on every card, and flags
any item that lacks one as "source unverifiable".

| Section | Connector | What to read (windowed) | Suggested action per item |
|---|---|---|---|
| `tickets` | Atlassian MCP `searchJiraIssuesUsingJql` | issues assigned to you, updated/due in the window | `ticket` → `detent run new --ticket <KEY>` (or clerk) |
| `mail` | Gmail MCP `search_threads` | unread / action-needed threads in the window | `thread` → draft a reply (Gmail `create_draft`) |
| `chat` | Slack MCP `slack_search_public_and_private` / mentions | mentions and active threads on your channels | `thread` → draft a reply (Slack `slack_send_message_draft`) |

**Identity precondition.** Before filtering, read `user.name` and `user.email`
from `detent.user.yaml`. If either is empty or the file is missing, stop and
tell the user: "herald needs `user.name` and `user.email` in detent.user.yaml
(copy detent.user.example.yaml)". Do not guess an identity or fall back to
the git config.

Set each item's `action` object: `{ type, label, command | url | key | thread }`.
If a section stayed `blocked`, leave `items: []` and keep its
`status`/`enable_action` — the panel surfaces it.

**Relevance filter — surface only what is genuinely the user's (hard rule).**
The brief is the user's plate, not a firehose of everything their teams touch.
Before adding a connector item, apply:

- **Drop bot/automated PR noise.** Dependabot / renovate / other bot-authored PRs
  never belong in the brief — the user did not write them and is not personally
  accountable for them. Exclude them outright (not even FYI).
- **Review-requests only when the user is PERSONALLY named.** Include a PR
  review-request only if the user is the *individually* requested reviewer or is
  @-mentioned by their own handle (`user.github_login` / `user.name` /
  `user.email` from `detent.user.yaml`; if `github_login` is empty, take it from
  `gh api user --jq .login`).
  A request routed to a **team / code-owner group** (e.g. `@your-org/your-team`;
  `user.teams` lists the user's own) is NOT personal — do not surface it. Same
  for Jira/Slack: include only when the item references the user's id directly
  (assignee, @-mention, direct reply), not a team channel broadcast or a
  watched-ticket worklog.
- **Always keep** the user's own authored PRs/commits, items assigned to them,
  on-call, and direct asks addressed to them.

When in doubt, leave it out — a missed FYI is cheaper than eroding trust in the
brief with noise the user has to keep dismissing.

### 4. Render the artifact

```sh
detent herald render <path-to>/brief-data-<date>.json
```

This writes ONE self-contained curator artifact to
`${DETENT_ROOT}/.plans/morning-brief-<date>.html` — sections by urgency, each
item a card with an **Act / Snooze / Dismiss** control — and records the new run
timestamp in `brief-state.json` (window advances; the render is the "success"
that stamps the run). Follow the curator writing-style rule (short sentences,
one idea per bullet, takeaway-first) — the renderer already does, keep any items
you add the same way.

### 5. Own the curator loop in THIS (main) session

The **main session** owns open → poll → apply — not a
subagent. Open the artifact as ONE clearly-labeled background shell and poll it:

```sh
detent curator open  ${DETENT_ROOT}/.plans/morning-brief-<date>.html
detent curator poll  ${DETENT_ROOT}/.plans/morning-brief-<date>.html   # background; blocks silently
```

The poll resolves with the user's per-item decisions (`item:<id>` → `act` /
`snooze` / `dismiss`) and any free-text notes (the per-card note box →
`comment`/`prompt` items). The instant it resolves, persist it to a file and run
`detent herald dispatch-plan` (step 6a) before acting — that ledger is what stops a
long list from stalling. A subagent may only AUTHOR extra artifact HTML and return
a path — it never opens, polls, replies, or ends.

Operational gotchas that otherwise stop feedback from landing:
- **Re-open after every re-render.** `detent curator open` serves a *snapshot* taken
  at open time. If you change the brief-data and `detent herald render` again, you
  MUST `detent curator open` the artifact again — otherwise the user keeps seeing the
  stale page (e.g. an added control or removed card that "isn't there"). Re-render
  → re-open → then tell the user to reload.
- **Never bound the poll/reply with `timeout`.** macOS has no `timeout` binary, so
  `timeout 25 detent curator …` errors out *before the command runs* and your reply is
  silently lost. Let `detent curator poll`/`reply` block (that is normal); if you must
  bound it use `gtimeout` (coreutils) or a node/`perl -e 'alarm'` wrapper, never
  bare `timeout`.
- **Poll-resilience:** if the poll dies, re-run once; if it says the server is
  unreachable from a sandboxed shell, re-run unsandboxed; after 3 consecutive
  failures, stop and escalate.

### 6. Act — persist a ledger, then drive it to zero pending

**This is the point of the brief — and Act must actually land, not just be noted.**
A click on **Act** IS the user's go-ahead. "Recorded but not launched" is a failure
of the brief, not a safe default. On a long list this is exactly where a session
can silently stall — so the flow is now **ledger-driven**, not memory-driven.

**6a. As soon as the poll returns, persist the worklist — before doing anything else.**
Write the poll result to a file and build the dispatch ledger:

```sh
detent herald dispatch-plan ${DETENT_ROOT}/.local/brief-data-<date>.json --feedback <poll-result.json>
```

This turns every `act` decision (and every note — a note is an instruction, so it
implies Act) into a persisted, urgency-ordered `brief-dispatch-<date>.json`, records
`snooze`/`dismiss` for carry, and prints a rough **ETA** (the work can run in the
background/parallel — see 6b for why the ledger *update* calls cannot). Tell the
user the count + ETA up front (e.g. "18 items, ~1–2h; working urgent-first"). The
ledger is now the **contract**: the run is not finished until it has zero pending
rows — no matter how long the list (10 or 50). If the session is summarized mid-run,
reload the ledger and continue from the first pending row; nothing is lost.

`dispatch-plan` also echoes any `general_notes` — poll feedback that wasn't tied to
a specific `item:<id>`. Treat these as instructions too, not just FYI; they are
easy to miss since no card carries them until you look.

Re-running `dispatch-plan` for a date that already has a ledger with non-pending
rows (in-progress/done/blocked/skipped) is refused — it would silently wipe that
progress and any recorded outcomes. Pass `--force` only if you deliberately mean to
discard the existing ledger; otherwise keep driving the existing one with
`dispatch-update`.

**6b. Work the ledger top-down.** For each item: launch its dedicated run (background
where possible so the user can keep triaging), then immediately mark it:

```sh
detent herald dispatch-update <ledger.json> --id <item-id> --status in-progress
# …when it lands / blocks:
detent herald dispatch-update <ledger.json> --id <item-id> --status done|blocked|skipped \
  --outcome "pushed abc123 / blocked on missing deploy credentials" --run "<pr-or-run-url>"
```

**`dispatch-update` MUST be called serially, from the main session only.** The ledger
file has no lock — it is a plain read-modify-write JSON write. Background runs do the
actual work in parallel, but they must return their outcome to the main session; only
the main session calls `dispatch-update` (one call at a time) to mark it. Never have
two background runs call `dispatch-update` concurrently — that races (there is a
best-effort reload-and-reapply if the file changed underneath a call, but it is not a
substitute for calling serially).

Batch large lists (fire a batch of background runs, then update as each returns) — but
**keep going**. Poll `detent herald dispatch-status <ledger.json>` to see what's left;
`complete:true` (zero pending/in-progress) is the ONLY signal the run is done.

**6c. When complete, re-render the outcome view and re-open the curator:**

```sh
detent herald dispatch-render <ledger.json>       # overwrites the same morning-brief-<date>.html
detent curator open ${DETENT_ROOT}/.plans/morning-brief-<date>.html
```

The artifact now shows every item's outcome (✓ done / ⛔ blocked / 💤 snoozed) with
the outcome text and run link — so "the curator shows once everything is done". Report
fixed / not-fixed / blocked per item.

- **Only the final outward side-effect gets its own confirm** — posting comments
  to GitHub, sending a mail/Slack reply, creating a ticket. Even then, don't defer
  vaguely: *do the work up to the write*, present the concrete draft/plan, and ask
  the single post/send question. A blocked/deferred item is marked `blocked` in the
  ledger with the reason — it is still tracked, never dropped.
- **Confirm each landed.** The `--outcome`/`--run` on each `dispatch-update` IS the
  evidence trail — capture the concrete artifact (commit SHA, review URL, draft id).

Launch each dedicated run/session using the item's `action`, so the brief stays a
dispatch surface:

| Item type | Act → dedicated run |
|---|---|
| **PR** (`type: pr`) | `detent sentinel <pr-url>` (sentinel sentinel) — or a new engine run driving the **respond** stage: `detent run new --ticket <pr-url>`. |
| **ticket** (`type: ticket`) | clerk on the requirement, or `detent run new --ticket <KEY>` to start an engine run. |
| **thread** (`type: thread`, mail/chat) | draft a reply via the connector (`create_draft` / `slack_send_message_draft`); surface the draft for the user to send. |
| **engine run** (`type: sdlc`) | run the item's `command` — `detent gate open <gate> --run <id>` if blocked, else `detent next --run <id>`. |
| **owl** (`type: owl`) | open the run's morning-review artifact in curator to accept/pivot its provisional decisions. |
| **Snooze** | add the item to `carry_context` for the next brief (`--carry` on render, or note it) — do not act now. |
| **Dismiss** | drop it; optionally note it in `carry_context` so it is not re-raised. |

Spawn each dedicated run in the background where possible so the user can keep
triaging the brief. Reply in curator with what you kicked off, then keep polling.

### 7. Carry continuity forward

Snoozed / deferred items and a one-line "what I kicked off" note become the next
brief's `carry_context` (rendered as "Context from last brief"). If you deferred
items, pass them on the render step: `detent herald render <data> --carry <json-array-file>`.

## Forbidden failure modes

- **Headless connector reads.** Never try to read Jira/Gmail/Slack outside an
  interactive session — they are not reachable, and pretending otherwise fabricates
  the brief. Mark them blocked with the enable action instead.
- **Silent blocked source.** A connector that is absent must appear in the "Access
  & data completeness" panel with its enable action — never omitted, never guessed.
- **Stalling with pending items (the cardinal sin).** Ending a turn with no tool
  action while the dispatch ledger still has `pending`/`in-progress` rows. The
  ledger is the contract: keep launching runs and marking outcomes until
  `dispatch-status` reports `complete:true`. A long list (10, 30, 50 items) is
  batched and worked to the end — never abandoned partway, never a silent no-op turn.
- **Acting from memory instead of the ledger.** After the poll, always
  `dispatch-plan` first. Looping over Act items from working memory is how items
  get dropped and how the run stalls — the persisted, resumable ledger exists
  precisely so neither can happen.
- **Never re-rendering the outcome view.** When the ledger completes, run
  `dispatch-render` + re-open the curator so it shows done/blocked/snoozed per item.
  Leaving the user on the pre-dispatch actionable artifact hides what actually happened.
- **Handling an item inline instead of dispatching a run.** Act = kick off a
  dedicated run; the brief is a dispatcher, not the place to do the work.
- **Recording an action instead of landing it.** Act is the go-ahead — launching
  a run and then asking "want me to actually run it?" strands the action. Drive it
  to its landing point (run started / review posted / reply surfaced) and report
  the concrete artifact; only the outward write gets a confirm.
- **Bounding a poll/reply with `timeout`.** macOS has no `timeout`; it errors
  before running and the reply is lost. Let `detent curator` block, or use `gtimeout`.
- **Re-rendering without re-opening.** `detent curator open` snapshots; a re-render the
  user never sees is a silent no-op. Re-render → re-open → reload.
- **Delegating the curator poll to a subagent.** The main session owns the loop
  a stranded subagent poll loses clicks.
- **Hardcoding "yesterday".** The window always comes from `brief-state.json`.
