# Plan v1: Amanborn007/detent-demo#1

## Approach
Add a `maxLength` option to `slugify` and apply it after the existing slug is built, so calls without it take the same path as today [brief.md#acceptance-criteria]. Validate `maxLength` first and throw `RangeError` when it is below 1 or not an integer [brief.md#acceptance-criteria]. To cut, take the first `maxLength` characters. If the slug is longer, back up to the last whole separator inside that window, so neither a word nor a multi-character separator is split [research.md#F2, research.md#R1]. If there is no separator in the window, keep the hard cut, which is the "first word is too long" case [brief.md#acceptance-criteria]. Finally strip any trailing separator with the same escaped regex the function already uses [research.md#F1]. What `null` means is open, so the step that handles it is conditional on D-001.

## Steps
1. Write failing tests in `test/slugify.test.js`, one behaviour per test as the file already does [research.md#F4]: result length at most `maxLength`, cut on a separator, first-word hard cut, no trailing separator for `-` and for a multi-character separator, `RangeError` for 0, -1, 2.5 and `"10"`, and output unchanged without `maxLength`. Files: `test/slugify.test.js`. Verify: `npm test` fails on the new tests only.
2. Implement validation and the cut in `slugify`. Files: `src/index.js`. Verify: `npm test` passes, including the 5 existing tests.
3. CONDITIONAL on D-001. Add a test and the handling for `maxLength: null`, as the answer to D-001 says. Files: `test/slugify.test.js`, `src/index.js`. Verify: `npm test` passes.
4. Document the option in the JSDoc `@param` and the README example [research.md#blast-radius]. Files: `src/index.js`, `README.md`. Verify: `npm test` passes and the README example output matches a run of `node -e`.

## Files touched
- `src/index.js`
- `test/slugify.test.js`
- `README.md`

## Risks
- A multi-character separator could leave half a separator at the cut [research.md#R1]. Step 1 tests `--`, and step 2 backs up to a whole separator.
- A new helper named `escape` would collide with the existing one [research.md#R2]. Step 2 adds no new helper with that name.
- `TypeError` for a non-string input and `RangeError` for a bad `maxLength` now coexist [research.md#F3]. Step 1 asserts the exact error class for each.

## Test strategy
- Length cap, separator cut, first-word cut, no trailing separator: step 1 tests, made green in step 2.
- `RangeError` on bad values: step 1 tests, made green in step 2.
- Unchanged without `maxLength`: the 5 existing tests plus one new equality test, all green after step 2.
- `null`: step 3, once D-001 is answered.
- Order: red tests committed first (step 1), then the code (step 2). Ship evidence is the `npm test` output on the final commit.

## Intent check
Fresh-context checker, given only brief.md and plan.md.

| Acceptance criterion | Covered by | Verdict |
|---|---|---|
| Result is at most `maxLength` characters | step 1 test, step 2 | covered |
| Cut lands on a separator | step 1 test, step 2 | covered |
| First word longer than `maxLength` is cut | step 1 test, step 2 | covered |
| Never ends in the separator | step 1 tests for `-` and `--`, step 2 | covered |
| `RangeError` below 1 or not an integer | step 1 tests for 0, -1, 2.5, "10", step 2 | covered |
| Unchanged without `maxLength` | existing 5 tests plus one new test, step 2 | covered |
| Tests cover each criterion | step 1, test strategy | covered |

Additions: step 4, documenting the option in JSDoc and the README, was not asked for. Filed as D-002.
