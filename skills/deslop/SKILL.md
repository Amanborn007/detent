---
name: deslop
description: >-
  Read-only review of YOUR OWN diff for AI-generated slop — gratuitous
  comments, defensive try/catch or null-guards on trusted internal paths,
  any-casts that erase a tracked type, and style drift vs. the surrounding
  file. AUTHOR mode only (refuses on someone else's PR). Proposes removals
  for approval through referee's fix-plan/checkpoint flow; never auto-edits.
  Trigger: /deslop [PR]
---

# deslop

**What it does.** A read-only review of *your own* diff for AI-generated
slop. It never touches someone else's code.

**AUTHOR mode only.** deslop refuses on a PR you don't own — proposing
deletions in your own code is one thing, doing it in a teammate's is another.
If invoked in REVIEWER mode (or with no PR and a diff that isn't yours), it
declines with one line rather than running anyway.

**Scope.** The diff under review is `git diff main...HEAD` (base resolved
`origin/main` → `main`, same resolution `hooks/eval-gate.sh` uses) when no PR
is given, or the PR's diff when one is. Exactly ONE fresh FAST-tier subagent
(`model: sonnet`) reviews it, given ONLY the diff — never the authoring
session's rationale or conversation, so the finding stands on the code alone.

**The slop taxonomy — exactly four categories:**
1. **Gratuitous / narrating comments** — comments that restate the code
   rather than explain a non-obvious *why*. This is the CANONICAL statement of
   detent's code-comment standard; `hooks/comment-discipline.sh` injects the
   short form at authoring time, and `skills/referee/SKILL.md` +
   `engine/stages/implement/SKILL.md` restate it. In full: comments are
   minimal and concise — they explain only a non-obvious *why*, they never
   restate what the code already says, and they never narrate the change
   itself (no PR, ticket-status or changelog prose in source). When the *why*
   is genuinely external — a spec, a decision, a workaround for someone else's
   bug — point at the ticket key instead of writing the paragraph
   (`// PROJ-2534`), at most once per construct, never as a per-hunk change
   marker. **Not slop, never propose removing:** documentation comments
   required by the language or repo convention on exported/public symbols
   (godoc, Javadoc, JSDoc/TSDoc, docstrings, licence headers) — stripping
   those breaks `revive`/`golint`/checkstyle and the ship stage's lint step.
   Keep them, and keep them short. The surface-independent half of this rule —
   state the mechanism, never the justification, so `by design`, `deliberately`,
   `intentionally` and `per convention` are all slop in a comment — lives in
   [`docs/evidence-and-voice.md`](../../docs/evidence-and-voice.md), which binds
   deslop as it binds every other producing skill.
2. **Abnormal defensive `try`/`catch` (or null-guards)** wrapping trusted
   internal paths that can't realistically fail.
3. **Casts to `any`** (or equivalent type-erasure) that erase a type the
   surrounding code otherwise tracks.
4. **Style drift** vs. the surrounding file — naming, formatting, or
   structuring conventions that don't match the file they land in.

**What a finding looks like.** Every finding carries a `[slop]` tag, its
category, the exact `file:line`, the exact hunk quoted, and a concrete
removal proposal:

```
[slop] Low — gratuitous comment · src/foo.ts:42
  > // increment the counter by one
  counter++;
Proposal: delete the comment (restates the code, explains no "why").
```

Precision over recall — high-confidence findings only, no padding the count
with maybes.

**Proposes, never rewrites.** Findings enter the standard fix flow: referee's
Phase 3 fix-plan, then the Phase 4 AUTHOR checkpoint. deslop never auto-edits
— nothing is applied or posted without your explicit approval at that
checkpoint, same as every other finding referee surfaces.

All mechanics — mode detection, the fresh-subagent dispatch, the merge into
referee's severity-ranked set, the fix-plan/checkpoint flow, and the honesty
rules (never claim "no slop found" for a pass that didn't run) — are owned by
`skills/referee/SKILL.md`'s "AI-slop lens (deslop)" section; that is the
authoritative gate/flow doc. This skill carries no review logic of its own —
it exists only so `/deslop` triggers naturally.
