# Handoff — 2026-10-20-amanborn007-detent-demo-1

Stage: **respond** · Ticket: Amanborn007/detent-demo#1

You are resuming a run you did not start. Everything below is a pointer
into `.sdlc/<run-id>/` — read the file, do not trust this summary alone.

## ⚠ This handoff is INCOMPLETE

The following would have to be rediscovered. Treat any conclusion that
depends on them as degraded, and say so rather than papering over it:

- decision D-001 discarded "throw RangeError on null", "other (specify)" with no recorded reason — record why with: engine decide-why --run <id> --decision D-001 --option <opt> --why "<reason>"
- decision D-002 discarded "drop step 4" with no recorded reason — record why with: engine decide-why --run <id> --decision D-002 --option <opt> --why "<reason>"
- decision D-003 discarded "revise" with no recorded reason — record why with: engine decide-why --run <id> --decision D-003 --option <opt> --why "<reason>"
- decision D-004 discarded "accept the agent's own review for this PR", "other (specify)" with no recorded reason — record why with: engine decide-why --run <id> --decision D-004 --option <opt> --why "<reason>"
- decision D-005 discarded "accept the hand-gathered evidence", "other (specify)" with no recorded reason — record why with: engine decide-why --run <id> --decision D-005 --option <opt> --why "<reason>"
- decision D-006 discarded "do not push" with no recorded reason — record why with: engine decide-why --run <id> --decision D-006 --option <opt> --why "<reason>"
- decision D-007 discarded "accept, note in PR", "fix in this PR", "don't ship yet" with no recorded reason — record why with: engine decide-why --run <id> --decision D-007 --option <opt> --why "<reason>"

## Settled — do not relitigate

- **D-001**: treat null like undefined (no cap)
  - rejected (no reason recorded): throw RangeError on null
  - rejected (no reason recorded): other (specify)
- **D-002**: keep step 4
  - rejected (no reason recorded): drop step 4
- **D-003**: approve
  - rejected (no reason recorded): revise
- **D-004**: wire a reviewer socket first
  - rejected (no reason recorded): accept the agent's own review for this PR
  - rejected (no reason recorded): other (specify)
- **D-005**: wire a verifier socket first
  - rejected (no reason recorded): accept the hand-gathered evidence
  - rejected (no reason recorded): other (specify)
- **D-006**: approve this push and draft PR
  - rejected (no reason recorded): do not push
- **D-007**: Fix in this PR
  - rejected (no reason recorded): accept, note in PR
  - rejected (no reason recorded): fix in this PR
  - rejected (no reason recorded): don't ship yet

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
