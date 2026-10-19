# Judge rubric: referee (REFEREE-J1)

You are grading whether `skills/referee/SKILL.md` and `skills/deslop/SKILL.md`
(both appended below, verbatim, each under its own `---` header) still teach
referee's doctrine as detent's PR review skill. This is a **static-fixture**
case: you are grading the skill files' own text, not a live review run or
transcript.

## Rubric dimensions (score each 0–1, then average for the final score)

1. **Never posts or fixes without approval.** Does the text require an
   explicit human confirm this session before posting to GitHub AND before
   applying any code change, in BOTH modes — with posting/fixing described as
   automatic-review-but-manual-action, never a fire-and-forget action?
2. **AUTHOR/REVIEWER auto-detection.** Does the text define how the mode is
   auto-detected (comparing the PR author to the viewer), state the behavior
   difference (author may fix locally; reviewer is comment-only and never
   touches the other person's branch), and allow an explicit `--mode`
   override?
3. **Deslop lens must NOT stamp `referee-done`.** Does the text explicitly
   forbid a `--lens deslop`-only pass from writing the PR inbox's
   `referee-done` marker, reserving that marker for a full review (both heavy
   engines, or a recorded reason they couldn't run)?
4. **Merged and deduped findings.** Does the text require merging findings
   from multiple engines/lenses into ONE severity-ranked, deduplicated set —
   explicitly deduping by root cause and dropping findings another bot/human
   already raised — rather than presenting each engine's output separately?
5. **Honesty about skipped engines.** Does the text gate each lens from the
   pack's `review.lenses` (null skill, unconfigured probe provider, failed
   network check, missing corpus, or `--skip-lens` each turn that lens OFF),
   require one plain line per OFF lens, and forbid silently omitting a lens or
   reporting "no findings" for a pass that never executed (including a failed
   deslop subagent)? An unreadable or invalid pack file must stop the run
   loudly, not fall back to defaults.

## RYG banding (informational)

- **green** — score ≥ 0.75: all five dimensions clearly present.
- **yellow** — score 0.4–0.75: most present, at least one vague or partial.
- **red** — score < 0.4: multiple dimensions missing, or the text allows
  auto-posting, auto-fixing, or a deslop-only pass to mark full review done.

## Output format

End your answer with exactly one JSON object on its own line:

```
{"score": <0..1>, "reasoning": "<one or two sentences citing which dimensions held up and which, if any, were weak>"}
```

Nothing after that line.

---
