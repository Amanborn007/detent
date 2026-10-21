# curator

A local, zero-dependency review surface for agent-generated plan artifacts.
An agent writes a self-contained HTML plan; curator serves it in your browser
with an injected annotation SDK; you highlight, comment, and answer decision
questions; the agent long-polls and receives your feedback as structured JSON
plus a `next_step` instruction — then replies into the page, and the loop
repeats until either side ends the session.

Concept credit: inspired by lavish-axi by Kun Chen (MIT) — see [NOTICE.md](NOTICE.md).
All code here is original.

## Requirements

Node >= 18. Built-in modules only (`node:http`, `node:fs`, `node:crypto`,
`node:test`) — there is nothing to `npm install`, no telemetry, no external
fetches, no auto-updates. The server binds `127.0.0.1` only.

`python3` on PATH, for `scripts/artifact-check.py`. `open` and `check` both run
it, and `open` refuses to serve an artifact that fails it. Without python3 every
open fails loudly rather than passing unchecked; `CURATOR_NO_CHECK=1 curator
open <file>` is the deliberate way past, and it says so on the success line.

## Try it in 30 seconds

```sh
cd engine/curator
node cli.mjs open examples/demo-plan.html   # starts the server, opens your browser
node cli.mjs poll examples/demo-plan.html   # blocks until you click "Send to Agent"
```

In the browser: alt-click any element to annotate it, select text to get a
floating "Annotate" button, click a decision option card, then hit
**Send to Agent** — the `poll` command returns your feedback as JSON.

## The loop (agent's view)

```sh
curator check <file.html>   # the pre-open gate on its own -> {check, problems, warnings}
curator open <file.html>    # -> {url, next_step}; browser opens. Runs the same check and
                             #    refuses to serve an artifact that fails it; CURATOR_NO_CHECK=1
                             #    opens unchecked and says so on the success line
curator poll <file>         # blocks (silent, space heartbeat every 15s) until
                             #    feedback or end; -> {status, prompts, next_step}
curator drain [<file>...]   # non-blocking: deliver pending feedback from EVERY
                             #    session in one sweep (or only the named pages, leaving
                             #    other sessions queued); run this at the top of every turn
curator reply <file> -m "<what you changed>"   # posts to the chat log, then polls again
curator log <file> -m "<decision → action → outcome>"  # append an audit line into the artifact on disk (no server needed)
curator end <file>          # agent-initiated end; browser shows an ended banner
curator status              # one JSON line per session
```

### Reliably catching feedback (`drain`)

Feedback is durable server-side but **delivered only by a poll of that exact
session** — so feedback sits queued forever in any session the agent never
armed, and a blocking `poll` background job can be killed by the harness
watchdog before it drains. `drain` is the fix: one **non-blocking** sweep that
lists every session (from the live server, or the durable state file when it is
stopped) and polls only the ones with `pending_feedback_items > 0`. A poll of a
non-empty queue resolves immediately, so `drain` never blocks and never depends
on a long-lived background job surviving. Run `curator drain` at the top of
every turn; it delivers each session's feedback plus a `drained` summary, and
reports `idle` when there is nothing queued.

Every command prints a single JSON line on stdout; errors are
`{"error": ..., "next_step": ...}` with exit code 1. The output is the
documentation — an agent never needs this README to drive the loop.

### Keeping the artifact in sync (`log`)

A `reply` is a transient chat ping; the artifact is the durable source of
truth the user reloads. So as decisions are answered and work lands, keep the
artifact current: update its body in place, and record what changed with
`curator log`. Unlike the other verbs, `log` never touches the server — it
edits the file on disk directly (so it works even when no poll is running or
the session has ended), appending a timestamped entry to a
`<section data-curator-changelog>` (created on first use, newest first).
This is what stops the page going stale behind the conversation — "reported it
in chat" is not the same as the user seeing it on the page.

Feedback sent while no poll is waiting is queued durably (in memory and
flushed to `~/.curator/state.json`); re-polling always retrieves it, even
across a server restart. A killed `poll` loses nothing — just re-run it.

## Feedback item shapes

| Interaction                  | Queued item |
|------------------------------|-------------|
| Alt-click an element         | `{type: "annotation", selector, elementText, comment}` |
| Select text → Annotate       | `{type: "selection", selector, selectedText, comment}` |
| Click a decision option      | `{type: "decision", question, answer}`, plus `note` when the "Why / note" field is filled — `{type: "decision", question, answer, note}` (one per question; re-choosing replaces) |
| Write a note, choose nothing | `{type: "decision", question, answer: null, note}` — the answer is the note itself, for when none of the options is right |
| `window.curator.queuePrompt(text)` | `{type: "prompt", text}` |
| Free-text comment box        | `{type: "comment", text}` |

## Decision blocks in artifacts

```html
<div data-plan-question="rollout-strategy">
  <div data-plan-option="Phased">Phased rollout ...</div>
  <div data-plan-option="Big-bang">Big-bang cutover ...</div>
</div>
```

The SDK makes options clickable, highlights the chosen one, and queues exactly
one answer per question. It also appends a free-text **"Why / note"**
field under each block; when filled it rides along with the answer as
`note` in the queued decision item. Supply your own field by placing a
`data-curator-note` element inside the block and the SDK will use that instead
of injecting one.

**The note is answerable on its own.** Options are the author's guesses at the
answer, and the reader may agree with none of them, so a note with nothing
chosen queues as `answer: null` with the note carrying the reply — it is never
discarded for want of a matching option. Emptying the note with no option
chosen retracts the decision. The SDK also renders each block as its own panel
with a "Decision needed" badge, in both light and dark themes, so the parts of
the page that want an answer do not read as more prose.

## Editing queued feedback

Everything in the queue is a draft until **Send**. Click any queued item to
edit it: annotations, selections and prompts edit their text, and a decision
edits its note (the answer itself changes by clicking a different option).
Clearing the text removes the item. Editing a decision's note pushes the new
text back into the artifact's textarea, so the two never disagree about what is
about to be sent.

## Architecture

- `cli.mjs` — command dispatch; spawns/reuses the detached server.
- `server.mjs` — `SessionStore` (queue/poll semantics, durable state) + HTTP
  layer. Session key = canonical absolute artifact path. Idle self-shutdown
  after 60 minutes with no live sessions.
- `sdk.js` — browser SDK injected into the artifact iframe
  (`sandbox="allow-scripts allow-forms"`, no same-origin). It talks only to the
  parent chrome page via `postMessage`; the chrome page talks to the server.
- The artifact is served verbatim from disk except for exactly one injected
  `<script src="/sdk.js?s=...">` tag, placed right after the doctype so the
  browser stays in standards mode (prepended if there is no doctype). The file
  on disk is never modified, and the server refuses to read anything resolving
  outside the artifact's registered directory. Requests with a non-loopback
  `Host` header are refused (DNS-rebinding guard).

## Tests

```sh
cd engine/curator
npm test          # = node --test test/  (unit + e2e; e2e binds 127.0.0.1)
```
