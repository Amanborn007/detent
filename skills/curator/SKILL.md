---
name: curator
description: use when about to present a plan, comparison, design options, review summary, or any decision-heavy output that is easier to grasp visually than as prose - render it as a curator artifact (in the central DETENT_ROOT/.plans/) instead of a wall of text, delegating all curator mechanics to subagents.
---

# curator — render plans as reviewable curator artifacts

Instead of dumping a long plan/comparison/report into chat, write it as a
self-contained HTML artifact and run it through curator
(`engine/curator/` in this config repo; CLI: `engine/curator/cli.mjs`).
The user reviews it in the browser — annotating elements, highlighting text,
answering decision questions — and you receive structured JSON feedback.

## 0. Delegate the mechanics to subagents — the main thread stays clean

ALL curator mechanics run in delegated subagents, never in the main
conversation: authoring the HTML artifact, the `open` call, the blocking
`poll`/`reply` loop, and applying raw feedback JSON. The main agent receives
only the distilled outcome — the decisions answered plus a short summary of
the user's annotations. Poll JSON, `next_step` strings, heartbeats, and
server chatter must never appear in the main thread; a main conversation
full of curator plumbing is this skill misused. Practically: spawn one
subagent to write + open + poll the artifact and report back
`{decisions, annotation_summary}`; spawn follow-up subagents for each
apply-feedback + `reply` round. Each apply-feedback subagent MUST also write
the outcome back into the artifact and `curator log` it before replying (see
§3) — the artifact stays in sync with the work, not just the chat. The engine
stage skills restate this rule at every gate (see `engine/stages/CONTRACT.md`,
"Curator via subagents").

## 1. Write the artifact

- VOICE: read [`docs/evidence-and-voice.md`](../../docs/evidence-and-voice.md)
  for the rules that hold on every surface — the evidence ladder, mechanism
  over justification, one ask, no status pills — then
  `${DETENT_ROOT}/.local/voice.md` before writing the prose, if it
  exists. An artifact is the user's document, read by them and often shared on
  — it must not read as model output. The rules that bite hardest here: verdict
  first, so a reader who stops after the first card has the answer; every
  section earns its place by changing what the reader does; separate proven
  from inferred EXPLICITLY, with what would settle each open item; numbers carry
  their caveat in the same sentence (`184 endpoints that received a retry — an
  upper bound, not failures`, never the bare figure); and when a later finding
  overturns an earlier one, say so at the top rather than quietly editing the
  middle. Banned: report-ese (`It is worth noting`, `This document outlines`,
  `As mentioned above`), editorialising (`the interesting part is`), em-dash
  chains, and justification in place of mechanism (`by design`). No file → the
  neutral rules above still apply; say the file was absent.
- Path: `${DETENT_ROOT}/.plans/<slug>.html` — `.plans/` lives CENTRALLY in
  the detent clone (`DETENT_ROOT`, falling back to the clone that contains
  `engine/curator/`), NOT in the work repo: tasks span multiple repos, so
  plan artifacts all point at the one detent home (which gitignores
  `.plans/`). Create the directory if needed; slug = short kebab-case topic,
  e.g. `.plans/search-migration.html`.
- SELF-CONTAINED: all CSS inline in a `<style>` block, system fonts only,
  no CDN links, no external images/fonts/scripts, no network fetches.
- STRUCTURE: a screen is an **ordered selection of blocks**, and may carry as
  many jobs as the work has — a runbook that also decides and also explains is
  the normal case, not a violation. Pick the blocks from
  [`engine/curator/blocks.md`](../../engine/curator/blocks.md); start from a
  default order in [`engine/curator/recipes.md`](../../engine/curator/recipes.md)
  (decide · investigate · track · explain · run · research) and add or cut.
  Decisions turn up on most pages, and often several per page, so a decision
  is a component rather than a kind of page.
- DIAGRAMS: the question is **how many**, never whether. One drawing per
  distinct flow, per comparison of three or more options, per set of counts or
  percentages, per before-and-after, per branching step sequence, per ranking.
  A mechanism or walkthrough block with no diagram is the failure this rule
  exists to stop, and it was common before this rule. Build them with the
  `diagram-design` skill.
- **`curator open` runs the check itself and refuses to serve an artifact that
  fails it.** You do not have to remember to run it; you cannot open past it.
  Run it yourself first anyway, so you read the problems before the gate does:

  ```bash
  curator check .plans/<slug>.html
  ```

  Reopening a legacy artifact written before these rules is the one case for
  `CURATOR_NO_CHECK=1 curator open <file>`. It is reported on the success line,
  so an unchecked open is visible rather than silent. Never reach for it to get
  a new artifact open — fix the artifact.

  It fails on: a resource fetched over the network from any tag or from CSS,
  protocol-relative URLs included; hardcoded paint inside an SVG; a status-badge
  class; stacked tables; an embedded Mermaid render; an SVG carrying only one of
  `role="img"` and `<title>`; and a **diagram obligation with no drawing in its
  own section**. Obligations come from a flow heading, a ranking heading, three
  or more percentage cells, and a comparison of three or more real options. The
  drawing has to sit in the section that owes it, and two obligations in one
  section need two drawings. Two warnings rather than failures: a missing
  dark-mode block, and a before-and-after heading with no drawing — the Delta
  map's drawing is recommended and may be skipped for a single named piece,
  which the check cannot tell apart from a broad delta. The detent guide artifact opts out of the badge and
  dark-mode checks with `<!-- artifact-check: guide -->`.
  - **What it cannot see, so you have to.** Branching steps, figures quoted in
    prose rather than a table, and two distinct flows under one heading are
    obligations the rule states and the check misses. It reads headings, tables
    and option counts; it does not read meaning. Passing is not the same as
    having drawn what the content owes. On paint it reads the SVG's own
    attributes and the rules that target it or the class and id hooks it
    carries; it does not resolve the CSS cascade, so a `color` set on an
    ancestor and inherited through `currentColor` gets past it.
  - The skeleton's example diagram carries `data-placeholder="true"` so a copied
    artifact does not start with a drawing it did not make. Delete the attribute
    when you replace it.
- EVIDENCE: every finding carries how it was obtained — read it, ran it,
  documented, reported, or inferred. The first four may be stated as verified.
  **An inferred finding never sits with them**; it goes under *Not yet proven*
  with what would settle it. `recipes.md` carries the ladder in full.
- THEME (mandatory): copy the `<style>` block from
  [`engine/curator/theme.html`](../../engine/curator/theme.html) verbatim and
  write the body against its classes. Do not invent a per-artifact palette —
  the point is that every screen looks like the same publication, so the reader
  learns the visual grammar once. The skin is warm paper `#faf8f5`, navy ink
  `#16273c`, one teal accent `#397882`, hairlines `#e1ddd7`, with a dark-mode
  block already written. Headings are a serif stack and labels are mono; that
  contrast is what carries the hierarchy, so keep both.
  - The accent is **editorial, not a signal**: 1–2 uses per screen. Accenting
    six things means nothing is focal.
  - `blockquote` is for someone else's words, `.box` for your own aside,
    `.verdict` for a one-line conclusion after reasoning. Using them the other
    way round reads as decoration.
  - **The theme ships no status-colour class.** A coloured word in a State
    column is a badge under another name, and the rule is to say the state in
    the sentence: "what I would pick", not a green `OK`.
  - Diagrams belong to the `diagram-design` skill, not to hand-rolled SVG.
    Caption each one with `.caption`. Inside the SVG, **reference the tokens —
    `fill="var(--paper)"`, `var(--ink)`, `var(--accent)` — never a hex
    literal**. A hardcoded `#faf8f5` background survives the dark-mode switch
    and leaves a light slab sitting on a dark page, which is what the first
    artifact written against this theme did in twelve places.
  - Fonts stay system-only even though a webfont would look better — an
    artifact has to render offline and on a locked-down machine. Reach for the
    serif stack, not a download.
  - One exception: the detent guide artifact keeps its own dark panel theme and
    status-pill vocabulary, per
    [docs/guide-artifact-template.md](../../docs/guide-artifact-template.md).
    Everything else — plans, gate artifacts, reports, comparisons — uses this
    theme.
- Make every decision you need from the user EXPLICIT as a decision block:

  ```html
  <div data-plan-question="rollout-strategy">
    <div data-plan-option="Phased">Phased — pros/cons ...</div>
    <div data-plan-option="Big-bang">Big-bang — pros/cons ...</div>
  </div>
  ```

  curator makes the options clickable and queues exactly one answer per
  question. One `data-plan-question` per decision; option values should be
  short, unambiguous answer strings.
- Visual hierarchy: risks get colored severity markers, tradeoffs go in
  side-by-side pro/con cards, decisions get their own clearly-labeled
  sections. Lead with a short summary; details below.
- Optional escape hatch: a button calling
  `window.curator.queuePrompt('...')` for canned feedback like
  "rethink the approach". See `engine/curator/examples/demo-plan.html` for a
  full reference artifact.

### Writing style (mandatory, GLOBAL)

Every curator artifact is **simple but in depth**. The VOICE rule in §1 is the
authority on register; this is the shape. Binds ALL artifact authors —
subagents writing gate artifacts and stage reports included. Dense jargon
paragraphs are a forbidden failure mode. Checklist:

- [ ] Short sentences, but whole ones. Concise means few claims, not clipped
      words — "there is no customer impact", not "no customer impact".
- [ ] One idea per bullet.
- [ ] Technical terms explained on first use, or replaced with the plain word.
- [ ] **Shape follows the content**: a table where the shape carries the
      meaning, prose where it doesn't. Do NOT reflex-convert every group of
      facts into a table — that is how an artifact becomes a spreadsheet nobody
      reads.
- [ ] A **bolded one-line takeaway** before any dense section — the reader can
      stop there and still be right.
- [ ] Depth layered, never lost: summary first, full detail after (or in a
      `<details>` expander).

Forbidden, because they read as model output rather than as a colleague:
status pills and severity chips (outside the guide artifact's own defined
vocabulary — see the template), three tables in a row, and a column of
`file.go:120` anchors carrying the finding. Put the finding in the sentence and
the anchor at the end of it.

**"Make it simpler" means cut whole sections, not shorten sentences.** Density
is the failure, not length. If the user has asked twice, delete sections.

Worked BAD→GOOD example: see "Writing style (mandatory)" in
[docs/guide-artifact-template.md](../../docs/guide-artifact-template.md).

### Artifact quality checklist (before opening)

- [ ] Voice file read (§1), and the artifact matches that register.
- [ ] Read it back as the user: is every section skimmable in one pass? A
      section needing a second read to parse is rewritten before opening.
- [ ] No horizontal overflow: `* { box-sizing: border-box; min-width: 0; }` —
      the `min-width: 0` matters on nested flex/grid children.
- [ ] Every decision you need answered is a `data-plan-question` block; state
      explicitly in the artifact which decisions you need answered.
- [ ] No external URLs anywhere (fonts, CSS, JS, images). System fonts only.
- [ ] Readable in light and dark (`color-scheme: light dark` + a
      `prefers-color-scheme` media query, or neutral colors that work in both).
- [ ] A one-line hint that alt-click annotates and text selection comments.

## 2. Open and poll

```sh
node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" open .plans/<slug>.html
```

It prints `{url, next_step}` and opens the browser. Then poll — as a
BACKGROUND task, because the harness may kill long-running foreground
commands:

```sh
node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" poll .plans/<slug>.html
```

- The poll blocks silently (a single-space heartbeat every 15s) until the
  user clicks "Send to Agent" or ends the session. That is normal — do NOT
  kill it or treat silence as a hang.
- If the poll IS killed (harness timeout, etc.), re-run it ONCE — feedback is
  queued durably server-side and is never lost.
- If it errors saying the server is "running but unreachable from this shell",
  you are in a sandboxed shell that blocks 127.0.0.1 — re-run the same command
  unsandboxed.
- After 3 consecutive poll failures (the CLI's `next_step` will say "stop
  retrying — escalate to the human"): STOP retrying and surface it to the
  user; do not keep looping.
- Polls delegated to subagents MUST carry these failure-mode instructions
  verbatim in the subagent prompt.

### Never miss feedback: `curator drain` every turn (mandatory)

A blocking `poll` only drains the ONE session it was armed on, and the harness
watchdog can kill a long-running background poll before the user sends — so
relying on a surviving background poll is how feedback gets missed. Feedback is
never lost (it is durable server-side, keyed by session), but it is only
DELIVERED when something polls that session. So the reliable pattern is a cheap,
non-blocking sweep of ALL sessions at the top of EVERY turn:

```sh
node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" drain
```

`drain` lists every session and polls only the ones with pending feedback
(those polls return immediately), so it never blocks and never depends on a
background job. It prints each session's feedback plus a `drained` summary, or
`{"status":"idle"}` when nothing is queued. Apply whatever it returns (§3),
then move on. This — not a long-lived background poll — is the primary
feedback-catching mechanism; the blocking `poll` above is only for actively
waiting inside a focused review subagent.

If `drain` is unavailable (older curator), the equivalent is `curator status`,
then `curator poll <key>` once for each session whose `pending_feedback_items`
> 0 (each such poll returns immediately).

## 3. Apply feedback, reply, repeat

The poll resolves with `{status, prompts, next_step}` — follow `next_step`
literally. On `status: "feedback"`:

1. Apply every prompt: `annotation`/`selection` items point at specific
   content via selector/text; `decision` items are the user's answers;
   `comment`/`prompt` items are free-text instructions.
2. **Do the work AND write it back into the artifact — mandatory, not
   optional.** A `reply` is a transient chat ping; the artifact is the source
   of truth the user reloads, so it must never go stale behind the
   conversation ("I reported it in chat" is NOT done — the user is looking at
   the page). For every decision answered / annotation actioned / task
   completed:
   - (a) update the SAME artifact file in place so the body reflects the
     resolved state — decisions marked answered, results filled in, status
     current (the browser serves it fresh from disk on reload); AND
   - (b) append an audit line to the artifact's change log:

     ```sh
     node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" log .plans/<slug>.html -m "<decision → action → outcome>"
     ```

     `log` writes straight to the file (no server or live poll needed) and
     creates a "Decision & Change Log" section on first use, newest entry
     first. Log one line per decision/action so the page carries a running
     record of what changed and why — this is what makes the artifact
     self-explanatory the next time the user (or you) opens it.
3. Reply so the user gets a chat ping of what changed, then keep polling
   (reply itself blocks like a poll — run it in the background too):

```sh
node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" reply .plans/<slug>.html -m "Switched to phased rollout; added cost note."
```

Treat a decision/annotation as DONE only once the artifact shows the outcome
and the change log records it. Delivering updates only in chat while the page
stays stale is the failure mode this loop exists to prevent.

**Never go idle with a session still open.** An open (non-ended) session must
always have a poll waiting on it — feedback the user submits while no poll is in
flight is queued on the server but delivered to no one, so the user "submits and
nothing happens". Before you stop a turn: either a `poll`/`reply` is running (it
blocks, that is correct), or you have `end`ed the session. The `Stop` hook
`curator-pending-feedback-check.sh` enforces this — it blocks the turn if any
open session still has undelivered `pending` feedback and tells you to `poll`
(with the exact invocation form above). It only considers sessions whose
artifact path is under `$CLAUDE_PROJECT_DIR`, `$DETENT_ROOT`, or `$PWD` —
never someone else's session or an unrelated background job — and it will not
re-block a pending set that a sandboxed-shell `poll` already recovered
read-only (tracked via `poll-failures.json`'s delivered fingerprint).

## 4. End etiquette

- `status: "ended"` means the user closed the session: STOP polling, do not
  reopen the artifact uninvited, and deliver any remaining updates in chat.
- If YOU are done first (all decisions answered, work complete), close with
  `node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" end .plans/<slug>.html` and
  summarize the outcome in chat.
- Never open more than one curator session per artifact at a time;
  `.plans/` artifacts are disposable working files — do not commit them
  unless the user asks.
