# Judge rubric: scribe output-slop (SCRIBE-SLOP-1)

You are grading ONE fixture reply (below) on the **output-slop** dimension:
how much AI-generated filler it contains, independent of whether its content
happens to be correct. This case does NOT grade `skills/scribe/SKILL.md`'s
prose (that's `SCRIBE-D1`, the doc-invariants case) — it grades whether the
dimension's calibration holds by scoring a fixed reply against the same
anchors a human would use to judge scribe's (and herald's — see the note at
the end) actual output.

Slop IS the score of this case. A score of **1.0 means zero slop**; a score
of **0.0 means maximally sloppy**. Do not blend in a correctness judgment —
a factually wrong but slop-free reply still scores high on THIS dimension.

## What counts as slop (from the deslop lens + scribe Layer A)

Pulled from `skills/deslop/SKILL.md` (via `skills/referee/SKILL.md`'s
AI-slop lens) and `skills/scribe/SKILL.md`'s Layer A voice guardrail:

1. **Filler openers/closers** — "I hope this finds you well", "I wanted to
   reach out", "just circling back", "Thanks so much and have a great day!",
   and similar padding that carries no information.
2. **Restating the ask back to the reader** — repeating what they already
   said instead of answering it.
3. **Hedging boilerplate** — "I think maybe we could possibly", stacked
   qualifiers, exclamation-mark padding, "feel free to" / "please don't
   hesitate to" / "kindly" / "I'd be happy to" / "as per" /
   "Additionally/Moreover/Furthermore" chains.
4. **Formats not native to the surface** — e.g. markdown headers or `**bold**`
   pasted into a Slack message (renders literally there), or scaffolding
   labels (`ASK:`/`FYI:`) on a one-line reply that didn't need them.
5. **Burying the lead** — intent (what's done / needed / asked) not stated in
   the first line, wrapped instead in throat-clearing.

A reply with NONE of the above, that leads with intent and stops when it's
said what it needs to say, is slop-free (green). A reply that says the right
thing but wraps it in filler is partial slop (yellow). A reply that is mostly
filler with the actual content buried or minimal is heavy slop (red).

## Calibration anchors

This case's `evals/calibration/output-slop/anchors.json` reference set is
injected mechanically below this rubric (see `anchors: "output-slop"` in
`case-scribe-slop-1.json` and `resolveJudgeCase` in `engine/eval/eval.mjs`) —
it is no longer hand-quoted here, so the rubric and the anchor set can never
silently drift apart in prose (see `evals/calibration/README.md`).

## Fixture reply to grade

Score THIS reply (and only this one) on the output-slop dimension, using the
calibration anchors injected below as your calibration reference:

> Hey! Thanks so much for flagging this — I just wanted to let you know that,
> as per my review, the deploy did go out and I think it's probably working
> now. Feel free to let me know if you run into anything, and please don't
> hesitate to reach out again. Additionally, I'd be happy to take another
> look if needed!

## Output format

End your answer with exactly one JSON object on its own line, scoring ONLY
the fixture reply above:

```
{"score": <0..1>, "reasoning": "<one or two sentences naming which slop patterns from the numbered list above are present>"}
```

Nothing after that line — a calibration reference block follows this rubric,
but it is input for your grading, not part of your answer.

## Note — scope

This dimension applies to scribe AND herald output (both produce reader-facing
prose that can slop up). This case grades scribe's suite only; a
herald-specific slop case is deferred (see `evals/calibration/README.md`'s
"Deferred" section for the calibration-mode gap, and the eval-corpus BUILD
SPEC's DEFERRED section for the herald case itself).
