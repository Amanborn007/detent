# Recipes

A recipe is a default order of blocks for a situation that comes up often. It is a
starting set, not a wall. Add blocks the content asks for and cut the ones it does not,
and do it without asking permission — the recipe has no authority over the content.

The reusable unit is the block, not the screen. A screen is an ordered selection of
blocks, and most real screens carry several jobs at once. Across the 73 artifacts written
in this repo so far, 74% carry a decision block and 45 of them carry three or more, which
means decisions are a component that shows up inside runbooks and investigations, not a
page type of their own. A Run screen that also carries two decisions and a diagram is the
normal case. A setup runbook is 43 headings, 4 decisions, 2 diagrams and 9
tables, and it is a single coherent screen.

Two rules survive every recipe. Verdict is always the first block, so a reader who stops
after one card still has the answer. Diagram count comes from the content and never from
the page: a distinct flow or call path gets one each, three or more options get a
cost-against-precedent quadrant, counts and shares get a bar or a line, what exists
against what is new gets a before-and-after, branching steps get a flowchart, and a
ranking gets a layer stack. Diagrams appear on 5 of the 73 past artifacts, which is the
largest single gap in the set, and tables appear on 85%, which is the reflex reach. Every
diagram goes through the `diagram-design` skill, and every fill and stroke references a
theme token (`var(--paper)`, `var(--ink)`, `var(--accent)`) so it survives the dark-mode
switch.

---

## Decide

When there is a fork in the work and the reader has to pick a way forward.

1. Verdict
2. What forces the choice
3. Approaches — one block per option, each with what it is, its cost, its precedent, and
   what it breaks
4. What I would refuse
5. Not yet proven
6. Decisions needed

Diagrams it will almost always owe: a cost-against-precedent quadrant once there are
three or more approaches, and one flow per approach that changes how the system is wired.

How it goes wrong: the recommendation is buried in the approaches instead of stated in
the verdict, so the reader has to reconstruct the answer by comparing options. Pick the
approach in the first line and let the approach blocks explain the pick.

---

## Investigate

When something behaved unexpectedly and the reader needs to know what is actually true.

1. Verdict
2. Findings — the claim in the sentence, the anchor at the end of it
3. Not yet proven — each item with why it is unproven and what would settle it
4. Corrections — what an earlier version of this page got wrong
5. What changes — what the reader does differently now

Diagrams it will almost always owe: one per call path the finding travels through, and a
before-and-after when the investigation names a change that has already landed.

How it goes wrong: a reasoned conclusion gets written as a finding. Anything reached by
inference belongs under Not yet proven with the check that would settle it, not in a list
of verified claims.

---

## Track

When work is in flight and the reader wants to know what needs them today.

1. Verdict
2. What needs you — every open item carrying a person's name
3. What moved since last time
4. Blocked and on whom
5. Decision change log
6. Everything else, in an expander

Diagrams it will almost always owe: usually none. A burn-down or a share-of-work bar
earns its place only when the counts themselves are the point.

How it goes wrong: it leads with status instead of the ask, so the reader scrolls past
three sections of progress before finding the one thing waiting on them. The named asks
go first, and the movement report goes after.

---

## Explain

When the reader needs to understand how something already works.

1. Verdict — what the thing does, in one line
2. Mechanism — grouped by area, one diagram per distinct flow
3. Walkthrough — the path through the code or the data, in order
4. Where it surprises you — the behaviour that reads wrong until you know why
5. Source pointer — where the committed truth lives, when this page is a rendering of it

Diagrams it will almost always owe: one per distinct flow, and a layer stack when the
areas sit in a hierarchy rather than side by side. This is the recipe that owes the most
diagrams and the one most often shipped without any.

How it goes wrong: the mechanism gets replaced with a justification. "The sidecar reports
separately by design" tells the reader nothing; "the sidecar reports the same request
again, so the destination count double-counts" tells them what happens. Say what happens.

---

## Run

When someone is about to execute a sequence against a real system.

1. Verdict — what this run does and what state it leaves behind
2. Preconditions
3. Steps — numbered, each with a check that can fail
4. Rollback
5. What to do when it fails — per failure mode, not one generic paragraph
6. Risks

Diagrams it will almost always owe: a flowchart wherever the steps branch or a check can
send the operator down a different path, and a before-and-after when the run changes the
shape of what exists.

How it goes wrong: a step has no check, so the operator cannot tell whether it worked and
carries the failure forward into the next step. Every step needs a check that is capable
of failing — "confirm the table exists" is a check, "the job should now be running" is
not.

---

## Research

When a question was asked and the answer had to be found rather than decided.

1. Verdict
2. The question, stated verbatim as it was asked
3. The short answer, or an explicit "cannot answer yet" with the reason
4. Where I looked, and where I did not look
5. Findings — each carrying its rung on the evidence ladder
6. Contradictions — both sources quoted
7. Gaps — what is missing and what it would cost to close each one
8. Materials I need — the blocked sources, which is a request and not a decision block

Diagrams it will almost always owe: a bar or a line wherever the answer rests on counts,
shares or percentages, and a quadrant when the research surfaced three or more candidate
answers.

How it goes wrong: "where I did not look" gets dropped, and the reader takes the search
as exhaustive. Neither "where I looked" nor "contradictions" appears in any of the 73 past
artifacts, so neither will appear unless you reach for it.

### The evidence ladder

Every finding carries the rung it stands on, strongest first.

1. **Read it** — code at a named file and line.
2. **Ran it** — this is the command and this is its output.
3. **Documented** — quoted from the page, with a link to it.
4. **Reported** — a person said it, quoted with who said it and when.
5. **Inferred** — reasoned to it, nothing observed.

Rungs 1 to 4 may be stated as verified. Rung 5 never sits with them. An inferred item goes
under "Not yet proven", with the check, the command or the person that would move it onto a
higher rung. This is a hard rule: a page that presents inference alongside observation is
telling the reader something it does not know.
