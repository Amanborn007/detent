# Judge rubric: scout (SCOUT-J1)

You are grading whether `skills/scout/SKILL.md` (appended below, verbatim,
under its own `---` header) still teaches scout's doctrine as the shared
research layer. This is a **static-fixture** case: you are grading the skill
file's own text, not a live scout run or transcript.

## Rubric dimensions (score each 0–1, then average for the final score)

1. **Attribution.** Does the text require every item in the returned brief to
   carry a source attribution, and explicitly forbid an unattributed claim
   from appearing in the brief at all?
2. **Provider-config honesty.** Does the text drive providers from the
   pack's `knowledge.providers` (resolved via `pack.path`, with a loud error
   for an unreadable or invalid pack), run `network.check_cmd` when set and
   skip it when null, classify an absent or unreachable provider as `blocked`
   with recorded probe evidence, skip it immediately rather than waiting or
   retrying into the void, and state any feature the pack leaves off (null or
   disabled provider, blast radius disabled) as OFF in one line instead of
   silently pretending it ran?
3. **Per-run caching.** Does the text define a cache location and key scheme
   scoped to the current run (e.g. under `.sdlc/<run-id>/`), with a rule that
   providers are not re-queried within the same run on a cache hit, and that
   caching is skipped (not invented) outside a run context?
4. **Ranked single brief.** Does the text require merging and ranking
   findings from all providers into ONE brief with a defined rank order
   (direct hits, blast-radius, domain knowledge, existing skills,
   background), rather than returning raw per-provider dumps?
5. **Failure handling.** Does the text require a `partial` brief (not a
   silently complete one) when any provider is blocked/partial, and forbid
   fabricating a brief from memory when all providers are down?

## RYG banding (informational)

- **green** — score ≥ 0.75: all five dimensions clearly present.
- **yellow** — score 0.4–0.75: most present, at least one vague or partial.
- **red** — score < 0.4: multiple dimensions missing, or the text allows
  silent provider omission or fabricated attribution.

## Output format

End your answer with exactly one JSON object on its own line:

```
{"score": <0..1>, "reasoning": "<one or two sentences citing which dimensions held up and which, if any, were weak>"}
```

Nothing after that line.

---
