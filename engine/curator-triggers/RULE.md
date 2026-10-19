# Standing rule: review surface (curator)

Destined for the user's global CLAUDE.md. Paste the block below verbatim as its own section.

---

## Review surface (curator)
Whenever you finalize a plan (including plan-mode plans on ExitPlanMode), complete a
research or deep-research report, or produce design options, a comparison, a review
summary, or a migration analysis — that deliverable MUST be rendered as a curator
artifact: a self-contained HTML file under `.plans/`, opened with `curator`, with
feedback collected through its poll loop. Never deliver these as a terminal wall of
text, and never as a bare .md file dumped in chat. This applies even when the content
already exists as text (e.g. an approved plan-mode plan): write the artifact and start
the loop BEFORE implementing. Short answers, code, commit messages, and ordinary
conversation are exempt. If curator is not installed, fall back to an .md file under
`.plans/` and state explicitly that curator was skipped.
