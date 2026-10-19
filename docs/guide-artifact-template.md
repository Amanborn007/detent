# guide-artifact-template — rendering GUIDE.md as a curator artifact

How to (re)generate the interactive guide (`.plans/detent-guide-v2.html` and its
successors) from [GUIDE.md](../GUIDE.md) so every regeneration looks and reads the
same. GUIDE.md is the content source of truth; the artifact is a rendering of it —
never let them say different things.

## Ground rules (from the curator skill, non-negotiable)

- **Self-contained**: all CSS inline in one `<style>` block; system font stack;
  no CDN links, external images/fonts/scripts, or network fetches.
- **File**: `.plans/detent-guide-v<N>.html` in the detent repo root (`.plans/` is
  gitignored there — artifacts are runtime output, GUIDE.md is the committed truth).
- One `<script>` at the bottom, only for decision-option selection state.
- Max width ~940 px, dark panel theme (palette below), generous line-height (≥1.6).
- **This dark theme and its pill vocabulary belong to THIS artifact only.** Every
  other curator artifact uses the standard warm-paper skin in
  [engine/curator/theme.html](../engine/curator/theme.html). Do not carry the
  pills or the dark panels into a plan, gate artifact, or report.

## Writing style (mandatory)

**Simple but in depth** — this rule is GLOBAL: it applies to every curator
artifact (guides, plans, gate artifacts, reports, comparisons), not just this
guide. a reviewer flagged real report sections as unreadable because they were dense
jargon paragraphs; depth is welcome, walls are not. The rules:

**Read `${DETENT_ROOT}/.local/voice.md` first** (the curator skill's §1 VOICE
rule). It is the authority on register; this section is the shape.

- **Short sentences, but whole ones.** If a sentence needs three clause
  separators, split it. Concise means few claims, not clipped words.
- **One idea per bullet.** A bullet that says two things is two bullets.
- **Shape follows the content.** A table where the shape carries the meaning,
  prose where it doesn't. Reflex-converting every group of facts into a table is
  how an artifact becomes a spreadsheet nobody reads; three tables in a row is
  the tell. Status pills are defined vocabulary for THIS guide artifact only
  (below) — never invent them for plans or reports.
- **Explain or avoid jargon on first use.** Either gloss the term inline
  ("JQL — Jira's query language") or use the plain word ("a Jira search").
- **A bolded one-line takeaway BEFORE any dense detail.** The reader must be
  able to stop after the bold line and still be right.
- **Layer depth: summary first, detail after.** Full detail is preserved — it
  just comes below the summary (or behind a `<details>` expander), never
  instead of one.

Worked example — a flagged sentence, rewritten:

> **BAD (as shipped, flagged unreadable):**
> "Arm-2 residual contamination (disclosed): (a) the embargo list itself names
> the two repos; (b) embargoed keys/summaries/PR titles unavoidably appeared in
> JQL/gh listings (bodies never fetched); (c) one real leak — a text-match
> JQL returned PROJ-123 with full body..."

> **GOOD (takeaway + plain bullets):**
> **Takeaway: Arm 2 saw three small traces of the embargoed work — all
> disclosed up front, and one was a real leak.**
> - The embargo list itself names the two hidden repos, so Arm 2 knew they existed.
> - Ticket keys, summaries, and PR titles showed up in Jira and GitHub search
>   result listings. Full ticket bodies were never fetched this way.
> - One real leak: a text-match Jira search returned ticket PROJ-123
>   with its full body.

Same facts, same depth — but the reader gets the verdict in one bold line and
each fact stands alone. Gate and report authors follow this section too; the
curator skill's authoring checklist points here.

## Section order — mirror GUIDE.md exactly, never reorder

| # | Section | Rendering |
|---|---|---|
| — | Title + subtitle | `<h1>` "Detent — your daily guide" + one-line sub with the updated date and "annotate anything unclear — gaps here are bugs". |
| — | Status legend | One `.legend` strip defining every pill used below. Always immediately after the subtitle — pills appear everywhere, so the key comes first. |
| 0 | Read me in this order | A visually distinct callout box (`.readorder`) at the very top of the body: the two reader paths (first-timer stops after §2; regular jumps to §3) + the numbered section list with in-page anchor links. |
| 1 | Start here | The 5-line mental model as a numbered list, then the memory device in a highlighted quote box. Optionally the one-picture pipeline strip (`.loop`) — nodes and arrows, human gates visually marked. |
| 2 | Your first day | One code block with the 3 commands (comments aligned), then the hooks paste-step as prose. End with the "expected state" line — every setup section must say what success looks like. |
| 3 | The daily flows | One `.recipe` card per flow, in GUIDE.md's order ("I have a requirement" / "I have a ticket" / "I pushed a PR" / "I'm going to sleep" / "I want to review something"). Numbered steps; every command in a `.trig` monospace block, copy-pasteable verbatim from GUIDE.md. Status caveats (e.g. clerk BUILDING, owl caution) rendered as pills in the recipe title. |
| 4 | The cast | One `.card` per component with exactly four parts: **name + status pill(s)** in the `<h3>`, **one-line what** as the tagline, **Triggers** row with commands in a `.trig` block, **Coming** row for planned refinements (with refinement numbers). Same component order as GUIDE.md. |
| 5 | Where things live | A two-column table (Place / What's there). Paths in `<code>`. |
| 6 | When things go wrong | One bolded symptom per entry ("curator isn't opening.") followed by the fix; commands in `.trig` blocks. No pills here — these are evergreen. |
| 7 | What's coming | The refinements table (# / refinement / status pill). Close with the freshness rule: update GUIDE.md first, regenerate the artifact from this template. |
| — | Decision blocks | See placement rules below. |

## Status pills — the only vocabulary

Never invent a new status; if reality doesn't fit, change GUIDE.md's legend first.

| Pill | Class | Color | Meaning |
|---|---|---|---|
| LIVE NOW | `pill live` | green `#9ece6a` | On the user's machine today. |
| IN PR | `pill pr` | blue `#7aa2f7` | Built and verified, awaiting merge. |
| BUILDING | `pill building` | cyan `#7dcfff` | Being worked right now. |
| PLANNED | `pill planned` | purple `#bb9af7` | Agreed, not started. |
| caution | `pill caution` | amber `#e0af68` | Qualifier next to another pill (e.g. "never run vs real claude"). Never the only pill. |

Pill CSS (keep verbatim so artifacts match across regenerations):

```css
.pill{display:inline-block;border-radius:999px;padding:2px 11px;font-size:11.5px;font-weight:700;vertical-align:middle}
.pill.live{background:rgba(158,206,106,.18);color:#9ece6a}
.pill.pr{background:rgba(122,162,247,.18);color:#7aa2f7}
.pill.building{background:rgba(125,207,255,.18);color:#7dcfff}
.pill.planned{background:rgba(187,154,247,.18);color:#bb9af7}
.pill.caution{background:rgba(224,175,104,.18);color:#e0af68}
```

Base palette: `--bg:#0f1117; --panel:#161a23; --panel2:#1d2230; --ink:#e8ebf2;
--muted:#9aa3b5; --border:#2a3040`.

## Decision-block placement

- **All decision blocks go at the very end**, after §7 — the guide is a reference;
  never interrupt a recipe or card with a question.
- **At most three** per artifact; each is one focused question with 2–4 short,
  unambiguous options.
- Syntax (curator makes options clickable, queues one answer per question):

  ```html
  <div class="q" data-plan-question="guide-clarity">
    <div class="qt">Is this guide clear enough to be your daily reference?</div>
    <button class="opt" data-plan-option="yes">Yes — keep it updated as things land</button>
    <button class="opt" data-plan-option="needs-work">Parts are unclear — I've annotated them</button>
  </div>
  ```

- Every guide regeneration MUST include the clarity question
  (`data-plan-question="guide-clarity"`) so each round gets an explicit clarity
  verdict. Add at most two more questions for whatever decision the round actually
  needs (e.g. "what next after this lands").
- Selection script (the only JS allowed):

  ```html
  <script>
    document.querySelectorAll('[data-plan-question]').forEach(function (q) {
      q.querySelectorAll('.opt').forEach(function (btn) {
        btn.addEventListener('click', function () {
          q.querySelectorAll('.opt').forEach(function (b) { b.classList.remove('selected'); });
          btn.classList.add('selected');
        });
      });
    });
  </script>
  ```

## Regeneration checklist

1. Edit GUIDE.md first; commit it. The artifact never carries content GUIDE.md lacks.
2. Render each section per the table above — same order, same commands, same pills.
3. Verify: no external URLs in `<link>`/`<script src>`/`<img>`; every command block
   diff-identical to GUIDE.md's; every pill from the vocabulary table; decision
   blocks only at the end and include `guide-clarity`; prose passes the
   "Writing style (mandatory)" section (takeaway lines before dense detail, no
   jargon walls).
4. Bump the version in the filename and the "updated" date in the subtitle.
5. Open with `curator open .plans/detent-guide-v<N>.html` and collect annotations —
   unclear spots are bugs against GUIDE.md, fixed there first (step 1).
