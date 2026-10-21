# Handoff — 2026-10-20-amanborn007-detent-demo-1

Stage: **ship** · Ticket: Amanborn007/detent-demo#1

You are resuming a run you did not start. Everything below is a pointer
into `.sdlc/<run-id>/` — read the file, do not trust this summary alone.

## Settled — do not relitigate

- **D-001**: treat null like undefined (no cap)
  - rejected: throw RangeError on null — a null from a config file means unset; separator already treats ?? that way
  - rejected: other (specify) — no other behaviour was needed
- **D-002**: keep step 4
  - rejected: drop step 4 — an option nobody can find in the docs is not usable
- **D-003**: approve
  - rejected: revise — the fresh intent check covered all 7 criteria
- **D-004**: wire a reviewer socket first
  - rejected: accept the agent's own review for this PR — wanted a reviewer independent of the author
  - rejected: other (specify) — no third path was needed
- **D-005**: wire a verifier socket first
  - rejected: accept the hand-gathered evidence — evidence from the author is not independent
  - rejected: other (specify) — no third path was needed
- **D-006**: approve this push and draft PR
  - rejected: do not push — the change was ready and verified
- **D-007**: Fix in this PR
  - rejected: accept, note in PR — it broke the documented no-split guarantee
  - rejected: don't ship yet — the fix was small and test-first

## Already tried — these did not work

- [failed] cut with window.lastIndexOf(separator) on slug.slice(0, maxLength) — a multi-character separator that starts inside the cap but ends past it is invisible to the window, so 'ab--cd--ef' at maxLength 7 gave 'ab'; red test 9529cdc, fixed by slug.lastIndexOf(separator, maxLength) in c595989

## How to run things here

- `verify`: `npm test`

- ⚠ the accent-strip regex in src/index.js holds raw combining characters, not \u escapes

## Read next

- `brief.md` — what this run is for
- `research.md` — what the codebase already does
- `plan/plan.md` — the approved approach
- `decisions.json` — full decision record
- `attempts.jsonl` — full failed-approach log
