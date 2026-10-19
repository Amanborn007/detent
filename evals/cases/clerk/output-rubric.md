# Judge rubric: clerk output quality (CLERK-J2)

You are grading ONE ticket-drafting OUTPUT (below) on the **clerk** dimension:
ticket-drafting quality for the fixed scenario the calibration anchors below
also respond to. This case does NOT grade `skills/clerk/SKILL.md`'s prose
(that's `CLERK-J1`, the doc-rubric case) — it grades a static, hand-authored
fixture output against the same anchors a human would use to judge clerk's
actual ticket drafts.

A score of **1.0 means green-anchor quality** (a delta-only draft that
reconciles overlap with in-flight work, records its precedent query, uses
the project's Jira profile for issue type and estimate unit, and flags
blocked/degraded-confidence sources honestly). A score of **0.0 means
worse than the red anchor** (duplicates in-flight work, fabricates precedent,
invents estimates from unreachable sources, assumes Story/points without the
project profile). Rank the fixture below against
the anchors — do not grade it on an absolute scale in isolation.

## Output to grade

> Delta draft (1 new ticket):
>
> PROJ-101 already covers the replay CLI, so only audit logging needs a new
> ticket.
>
> New ticket: "Audit logging for DLQ replays"
> Description: record who replayed which messages, when, and the outcome in
> an append-only log. Depends on PROJ-101's replay command.
> Estimate: 3 points, similar scope to past alerting tickets.
>
> (No precedent query is recorded for that "similar scope" claim — the
> estimate is asserted, not backed by a cited search. The DLQ retention
> design doc was summarized by asking a teammate over Slack rather than fetched
> directly this session, and no blocked-source / degraded-confidence flag is
> raised anywhere in the draft. The draft also never says it loaded the PROJ
> Jira profile, so the "points" unit is not checked against the project's
> actual estimate field.)

## Output format

End your answer with exactly one JSON object on its own line:

```
{"score": <0..1>, "reasoning": "<one or two sentences citing which anchor(s) the output ranks closest to and why>"}
```

If you genuinely cannot place this output against the anchors (e.g. the
fixture is ambiguous or off-topic for the scenario), you may instead emit
`{"score": <your best-effort estimate>, "uncertain": true, "reasoning": "..."}`
— an uncertain vote is excluded from the panel's median, never silently
folded in as if it were confident.

Nothing after that line.

---
