# Block library

A curator screen is an ordered selection of the blocks below, and it may carry as many jobs as the work actually has. A runbook that also settles four decisions and maps two flows is one screen carrying a verdict, a brief, four decision blocks and two mechanism blocks. A block with nothing in it is left out rather than filled with a placeholder.

One order is fixed. The `<h1>` states the finding in one line, the brief comes right after it, every decision comes after the brief, and everything else (evidence, access panel, diagrams) comes after the last decision under a `Background` heading. A reader who stops after the decisions has still been asked everything.

Recipes name a default starting set of blocks for a kind of work. They are starting sets, not walls. Add a block a recipe does not list the moment the work has that content.

## The decision page skeleton

Use this shape exactly. `engine/curator/contract.mjs` checks it, and `theme.html` carries it as a component.

```html
<h1>{finding in one line}</h1>
<section data-plan-brief>
  <p data-brief="goal"><b>What we are trying to do:</b> …</p>
  <p data-brief="done"><b>What is already done:</b> …</p>
  <p data-brief="ask"><b>What i need from you:</b> …</p>
  <p data-brief="next"><b>What happens after you answer:</b> …</p>
</section>
<div data-plan-question="rollout" data-plan-recommended="phased" data-plan-required data-plan-shape="pick-one">
  <h3>Should we …?</h3>
  <p data-plan-why-now>Why now: …</p>
  <p data-plan-reason>Recommended: phased, because …</p>
  <div data-plan-option="phased"><strong>Phased rollout</strong>
    <p data-plan-consequence>…</p>
    <p data-plan-then>If chosen: …</p></div>
  …
</div>
<h2>Background</h2>
```

What the contract requires of every page that has a decision:

- Brief: all four parts, each a whole sentence of at least 5 words after its label, none only a path or URL. It is the first element after the `<h1>`.
- No more than 250 words of visible text before the first decision.
- Question: the first `h2` to `h4` inside the block, 40 words or fewer, ending in "?".
- Recommendation: `data-plan-recommended` names an option key and a `data-plan-reason` gives at least 5 words of reason. With no recommendation, write `data-plan-no-recommendation="{why}"` in at least 5 words.
- Each option has a `<strong>` label that reads as words (not the key again) and a `data-plan-consequence` of at least 4 words saying what happens if it is chosen. Escape hatches such as "Other" or "Skip" need no consequence.
- Context is the excerpt text itself. "Context: c" or a bare file path tells the reader nothing.
- Warnings: an ID like `DUNE-35` with no `<abbr title>` or `[data-plan-glossary]` entry, more than 7 decisions on one page, and any text telling the reader to alt-click or click an option. Annotation instructions belong to the shell, not the page.

The option key (`data-plan-option="phased"`) is the answer string sent back to you. The label is for the reader. Keep the key short and stable, and write the label and consequence in full.

| Block | Diagram obligation |
| --- | --- |
| Verdict | none |
| Brief | none |
| Decisions needed | none |
| Decision change log | none |
| Mechanism / walkthrough | required, one per distinct flow |
| Approaches | required when there are 3 or more options |
| What I would refuse | none |
| Findings | none |
| Not yet proven | none |
| Corrections | none |
| Delta map | recommended, before-and-after |
| Steps | required when the steps branch or can fail |
| Risks | none |
| Effort | none |
| What needs you | none |
| Materials I need | none |
| Source pointer | none |

## Verdict

Gives the reader the answer in the first line so they can stop reading and act.

Must contain one sentence stating the answer, the recommendation, or the state of the work. It is the page's `<h1>`. Where the answer is conditional, the condition sits in the same sentence.

Must not contain a preamble, a scope statement, a list of what the screen covers, or a restatement of the question. It is not a summary of the screen; it is the conclusion of the screen.

No diagram.

Commonly got wrong by opening with status instead of the answer. "Investigated the retry path across three services" is a status line. "The retries are safe to enable, the duplicate risk is in the ledger write and not the retry itself" is a verdict.

## Brief

Tells a reader who has never seen this work what is going on and what you want, in four short parts.

Must contain `goal`, `done`, `ask` and `next`, in that order, each one whole sentence of at least 5 words after its bold label. It sits right after the `<h1>`.

Must not contain a path or URL standing in for a sentence, a list of what the page covers, or status. The `ask` part says how many decisions there are and what they are about.

No diagram.

Commonly got wrong by writing the brief as a pointer ("see plan.md") so the reader has to open another file before they can decide.

## Decisions needed

Collects the asks that need the reader to click, so the run can continue. They come straight after the brief, before any background.

Must contain one block per ask in the skeleton above: a question ending in "?", why it is being asked now, a recommendation with its reason (or an explicit statement that there is none, and why), and for each option a label, the consequence of choosing it, and what you do next. Pick one of the five decision shapes: pick one, approve each, order these, gate, or open ask, and set it in `data-plan-shape`. Mark a decision `data-plan-required` when the run cannot continue without it.

Must not contain questions the author can answer alone, rhetorical framing, or an entry whose options are all the same action in different words. Open asks that need a person to act elsewhere go to "What needs you".

A comparison table of the options is allowed after the option cards, never in place of them.

No diagram.

Commonly got wrong by rendering every ask as pick-one because that is curator's oldest primitive. A list where each line needs its own yes or no is approve-each; a choice about sequence is order-these; a proceed, park or stop for the whole run is a gate. It is also got wrong by listing options with no consequences, so the reader has to guess what each click does.

## Decision change log

Records what was already answered and when, so a reader returning to the screen does not re-decide settled things.

Must contain a dated line per decision, what was decided, and what changed in the work as a result. Entries are append-only; a superseded decision stays with a later line reversing it.

Must not contain pending asks, and must not contain the reasoning that led to the decision beyond one clause. It is a record of what happened, not a place to relitigate.

No diagram.

Commonly got wrong by editing an entry in place when a decision is reversed, which erases the fact that the reversal happened.

## Mechanism / walkthrough

Explains how the thing actually works, grouped by area, so the reader can follow the path a request or a record takes.

Must contain the components or steps in the order they execute, named as they are named in the code, with the file or module each lives in. Where behaviour depends on config or a flag, name the flag and where it is read.

Must not contain justification for the design ("by design", "deliberately", "intentionally", "per convention" are all banned). State the mechanism and let it stand. It must not contain a walkthrough of code the reader can already see in a diff.

**Diagram required — one per distinct flow.** Two call paths that diverge are two diagrams, not one diagram with two branches bolted on. Build them through the diagram-design skill.

Commonly got wrong by describing a flow in prose and skipping the diagram because the prose "already covers it". Diagrams appear on 7% of past artifacts and this is the single biggest gap in the library; the prose is not a substitute for the picture.

## Approaches

Lays out the ways forward so the reader can compare them on the same terms.

Must contain one sub-block per option, each stating what the option is, what it costs, what precedent exists for it in this codebase or another team's, and what breaks if it is chosen. Every option gets all four; an option missing its cost or its breakage is not yet an option.

Must not contain a recommendation buried in the third option — the recommendation belongs in Verdict. It must not contain straw options included to make a preferred one look better; a rejected option with a real case goes to "What I would refuse".

**Diagram required when there are 3 or more options** — a quadrant of cost against precedent, so the reader sees the spread rather than reading four blocks and holding them in their head.

Commonly got wrong by replacing the option cards with a comparison table. A table flattens cost, precedent and breakage into cells that all look equally weighted, and it hides what each option does to the system. Put the cards first and the table after them.

## What I would refuse

Names the options that were considered and rejected, so the reader does not spend the review proposing them.

Must contain the rejected option and the specific reason it fails here, in the reader's terms.

Must not contain options nobody would propose, and must not read as a defence of the chosen approach.

No diagram.

## Findings

Delivers what was learned as claims the reader can act on.

Must contain one claim per entry, stated as a sentence, with its anchor at the end of that sentence — a file and line, a command and its output, a quoted doc line, or a named person and date. Every finding carries its rung on the evidence ladder: read it, ran it, documented, or reported.

Must not contain inferences. Rung 5, reasoned-to but nothing observed, never sits with verified findings; it goes to "Not yet proven" with what would settle it. Findings must not contain claims without an anchor.

No diagram.

Commonly got wrong by degenerating into a column of file anchors — `retry_handler.py:88`, `ledger.py:212` — with a fragment of a label each. The claim is the content and the anchor is the evidence for it, so the sentence carries the claim and the anchor closes it: "the retry handler writes the ledger row before the idempotency key is set, so a retry inside the window writes twice (`ledger.py:212`)."

## Not yet proven

Separates what is believed from what is verified, so the reader knows which parts of the screen to lean on.

Must contain each unproven item, why it is unproven, and the specific check that would settle it — a test to run, a log to query, a person to ask.

Must not contain items that were actually verified and merely feel uncertain, and must not contain vague hedges with no settling check attached.

No diagram.

## Corrections

States what an earlier version of this screen got wrong, so a reader who already read it updates.

Must contain what was claimed, what is true instead, and what in the current screen changed because of it.

Must not contain silent edits — a correction that only appears as changed text elsewhere on the page is not a correction.

No diagram.

## Delta map

Shows what already exists against what is new, so the reader sizes the change rather than reading it as a whole system.

Must contain the existing pieces the change touches, the new pieces, and which existing pieces are left alone. Where something is being replaced, both sides are named.

Must not contain a full inventory of the system; only what the change touches, and what it leaves
alone where a reader would expect it to have been touched.

**Diagram recommended** — before-and-after, the two states side by side. Skip it only when the delta is a single named piece.

## Steps

Gives the reader an ordered procedure they can run, with a way to know each step worked.

Must contain numbered steps, a check after each step that can actually fail and say so, and a rollback for the sequence or for each step that needs its own. Commands appear as commands, ready to run.

Must not contain a check that cannot fail ("confirm the deploy looks right"), and must not end without a rollback.

**Diagram when the sequence branches or a step can fail into a different path** — a flowchart of the branches. A strictly linear sequence needs no diagram.

## Risks

Names what could go wrong and what it would take to notice.

Must contain each risk, what it would break, and how it would be detected.

Must not contain severity chips, colored markers, likelihood ratings, or badge rows. Say how bad it is and how likely it is in the sentence, in plain words.

No diagram.

## Effort

Gives the reader both estimates so they can plan against a real number.

Must contain the human baseline and the AI-assisted estimate, both, and one sentence on what drove the gap between them. Numbers carry their caveat in the same sentence.

Must not contain a single blended number, and must not apply a flat speedup multiplier across task types. Where a part of the work barely moves with an agent — a gnarly bugfix, mature code, an unclear spec — say so rather than smoothing it into the total.

No diagram.

## What needs you

Lists the open items that need a named person to act, so nothing waits on nobody.

Must contain each item, the person's name against it, and what unblocks once they act.

Must not contain items owned by the author, and must not contain an unnamed owner. "Someone on the platform team" is not an owner.

No diagram.

Commonly got wrong by rendering these as clickable decisions. An open ask needs a person to act elsewhere; a click on it changes nothing, so it renders as a request with a named owner, not a decision block.

## Materials I need

States the sources that were unreachable, so the reader can decide whether to unblock the work.

Must contain each blocked source, why it matters to the conclusions, and what improves once it is available. Every conclusion that depends on a blocked source is marked as degraded-confidence where it appears.

Must not contain anything clickable. This is not a decision block and there is nothing to answer here; the reader either provides the source or does not.

No diagram.

Commonly got wrong by being rendered as a decision block, which invites a click that resolves nothing and leaves the source still missing. It is also commonly got wrong by omission — working around the missing source silently and never saying the conclusion is degraded.

## Source pointer

Tells the reader where the committed truth lives, when the screen is a rendering of something else.

Must contain the path, branch or URL of the source of record, and one sentence on what the screen adds over reading it directly.

Must not contain content that only exists on the screen. Anything the reader must not lose belongs in the source, not here.

No diagram.

## Diagram count rule

The number of diagrams on a screen comes from the content, never from a per-page quota. Count them by walking the content:

- a distinct flow or call path — one each, architecture or data flow
- three or more options — one, a quadrant of cost against precedent
- counts, shares or percentages — one, bar or line
- what exists against what is new — one, before-and-after
- steps that branch or can fail — one, flowchart
- a ranking or hierarchy — one, layer stack or pyramid

A screen with two flows and four options owes three diagrams. A screen with none of the above owes none, and adding one to decorate the page is worse than leaving it out.

Every diagram goes through the diagram-design skill. Hand-rolled markup and Mermaid are both out. Every fill and stroke references a theme token — `var(--paper)`, `var(--ink)`, `var(--accent)` — rather than a hex literal, so the diagram survives the dark-mode switch.

**The drawing sits in the section that owes it.** A drawing elsewhere on the page does not discharge this obligation, and two obligations in one section need two drawings.

**What `artifact-check.py` can and cannot see.** It catches a flow heading, a ranking heading, three or more percentage cells, and a comparison of three or more real options. A before-and-after heading is a **warning** there, not a failure, because the Delta map's drawing is recommended above and may be skipped when the delta is a single named piece — the check cannot tell a one-piece delta from a broad one, so it says so and leaves the call to you. It misses branching steps, figures quoted in prose rather than a table, and two distinct flows sharing one heading — it reads headings, tables and option counts, not meaning. Those four rows above the check cannot see are still owed; passing the check is not the same as having drawn what the content owes.

On paint it reads the SVG's own attributes and the stylesheet rules that target it or the class and id hooks it carries. It does not resolve the CSS cascade, so a `color` set on an ancestor and inherited through `currentColor` gets past it.
