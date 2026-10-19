# Judge rubric: scout output quality (SCOUT-J2)

You are grading ONE research-brief OUTPUT (below) on the **scout** dimension:
research-brief quality for the fixed scenario the calibration anchors below
also respond to. This case does NOT grade `skills/scout/SKILL.md`'s prose
(that's `SCOUT-J1`, the doc-rubric case) — it grades a static, hand-authored
fixture brief against the same anchors a human would use to judge scout's
actual output.

A score of **1.0 means green-anchor quality** (every line attributed, a
blocked provider named as blocked with its probe, the brief honestly marked
partial when a provider is missing, any feature the pack leaves off stated as
OFF in one line). A score of **0.0 means worse than the red anchor** (a
confident, unattributed brief with no acknowledgment that any configured
provider was even attempted). Rank the fixture below against the anchors —
do not grade it on an absolute scale in isolation.

## Output to grade

> Ranked brief:
> 1. [direct hit] A rotated signing key stays valid for a 24-hour overlap
>    window — source: repo-docs docs/signing.md.
> 2. [direct hit] keys.yaml's `retire_after` field is enforced by
>    `KeyRetireJob`, which pages the on-call engineer — source:
>    webhook-dispatcher/keys.yaml.
> 3. [blast-radius] PROJ-103 moved key-rotation ownership to the delivery
>    team — source: Jira PROJ-103.
> 4. The org-kb lookup was not attempted this session.
>
> (Line 4 gives no probe/evidence and never classifies org-kb as `blocked` —
> it's just noted as "not attempted". The brief is never marked `partial`
> anywhere despite that unqueried provider.)

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
