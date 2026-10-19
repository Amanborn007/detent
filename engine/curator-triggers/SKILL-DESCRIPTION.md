# Sharpened description for the curator skill

Apply AFTER the curator skill lands. Replace the `description:` line in the YAML
frontmatter of `skills/curator/SKILL.md` with the block below. Written for Claude Code's
skill matching: explicit trigger nouns/verbs first, exclusions last, one line of YAML.

## Ready patch block

```yaml
description: Render reading-heavy deliverables as a visual curator artifact (self-contained HTML under .plans/) and run the curator feedback poll loop — never a terminal wall of text. ALWAYS use when any of these is produced or finalized: a plan (including plan-mode plans — fire on ExitPlanMode/plan approval, before implementing), a research report, deep-research output, design options or alternatives, a comparison or trade-off matrix, a review summary, a migration analysis, or a long status/analysis report (~60+ lines of prose). Also when the user says "plan this", "research", "compare", "options", "what are the trade-offs", "review summary", or "show it in curator". NOT for short answers, code, diffs, commit messages, or ordinary conversation.
```

## Why this phrasing

- **Explicit trigger list** — skill matching keys on concrete nouns in the description;
  every deliverable type from the standing rule (RULE.md) is named verbatim: finalized
  plans, plan-mode exits (ExitPlanMode), research reports, deep-research output, design
  options, comparisons, review summaries, migration analyses.
- **"ALWAYS use when"** — matches the always-on intent; the model treats it as a
  blocking trigger rather than an optional capability.
- **User-utterance triggers** — quoted phrases ("plan this", "compare", ...) catch the
  request BEFORE the deliverable exists, so the loop starts at the right time.
- **Timing cue** — "fire on ExitPlanMode/plan approval, before implementing" mirrors the
  PostToolUse hook (hooks.md) so skill and hook reinforce the same behavior.
- **Explicit exclusions** — "NOT for short answers, code, diffs..." prevents
  over-triggering on every response, which is what gets broad skills ignored.
