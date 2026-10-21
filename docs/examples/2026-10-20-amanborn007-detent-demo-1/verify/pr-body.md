Closes #1. Callers can cap a slug's length with `maxLength`, and the cut never splits a word or leaves a dangling separator.

Run `2026-10-20-amanborn007-detent-demo-1`, made with [Detent](https://github.com/Amanborn007/detent). The plan and the run record are in Detent's `docs/examples/`.

## What changed
- `slugify(input, { maxLength })` validates `maxLength` (an integer of at least 1, else `RangeError`). `null` or omitted means no cap.
- A long slug is cut at the last separator that starts within the cap. With no separator in range, the first word is cut at `maxLength`.
- With `maxLength` set, a separator that contains letters or digits (or is empty) throws `RangeError`, because it cannot mark a word boundary.
- JSDoc and README document the option.

## Evidence
| Acceptance criterion | Evidence |
|---|---|
| At most `maxLength` characters | `verify/claims-run.txt` C1: lengths 5, 11, 11, 11 for caps 5, 11, 12, 13 |
| Cut lands on a separator | C2: `hello-brave`, and `ab--cd` with a `--` separator |
| First word longer than the cap is cut | C3: `super` |
| Never ends in the separator | C4: `hello-brave` at cap 12, `ab` with `--` at cap 3 |
| `RangeError` below 1 or not an integer | C5: 0, -1, 2.5, "10", NaN all throw |
| Unchanged without `maxLength` | C6, plus the 5 tests that existed before |
| Tests cover each criterion | `npm test`: 13 pass, 0 fail |

## Decisions
- D-001 `maxLength: null`: treat null like undefined (no cap).
- D-002 docs step: keep step 4.
- D-007 reviewer finding, an empty or alphanumeric separator could split words: fix in this PR.

## Reviewer notes
- Reviewed by the built-in `claude-reviewer` socket and verified by the built-in `cmd-verifier` socket (verdict pass, 7 of 7 claims with evidence). The final review pass returned no findings.
- Recorded, not changed (reviewer no-op): `maxLength: Infinity` throws `RangeError`, which matches the documented integer contract.
- Not changed: the existing trim regex is built from the separator, so with `--` it reads `^--+`. That matches any run of two or more dashes, which is out of scope here.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
