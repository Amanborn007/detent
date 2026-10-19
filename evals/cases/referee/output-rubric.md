# Judge rubric: referee output quality (REFEREE-J2)

You are grading ONE PR-review-findings OUTPUT (below) on the **referee**
dimension: review-findings quality for the fixed scenario the calibration
anchors below also respond to. This case does NOT grade
`skills/referee/SKILL.md`'s prose (that's `REFEREE-J1`, the doc-rubric
case) — it grades a static, hand-authored fixture findings-set against the
same anchors a human would use to judge referee's actual review output.

A score of **1.0 means green-anchor quality** (the planted critical leads,
ranked by severity, findings deduped, evidence cited, skipped engines
disclosed honestly). A score of **0.0 means worse than the red anchor** (the
critical is missed entirely, only cosmetic comments remain, and a skipped
lens is reported as "no findings" rather than disclosed as skipped). Rank
the fixture below against the anchors — do not grade it on an absolute
scale in isolation.

## Output to grade

> 1. [low] renamed `foo_bar.py` — no functional change.
> 2. [low] renamed `baz_qux.py` — no functional change.
> 3. [low] renamed `widget_helper.py` — no functional change.
> _(...32 more near-identical low-severity rename comments, one per file,
> never merged into a single finding.)_
> 36. [medium] the `except Exception: pass` block around the webhook handler
>     swallows errors — consider adding logging.
>
> (No mention anywhere of whether the cross-system blast-radius lens ran or
> was skipped.)

## Output format

End your answer with exactly one JSON object on its own line:

```
{"score": <0..1>, "reasoning": "<one or two sentences citing which anchor(s) the output ranks closest to and why>"}
```

If you genuinely cannot place this output against the anchors, you may
instead emit `{"score": <your best-effort estimate>, "uncertain": true,
"reasoning": "..."}` — an uncertain vote is excluded from the panel's
median, never silently folded in as if it were confident.

Nothing after that line.

---
