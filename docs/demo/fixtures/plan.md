# Plan: acme/widgets#1

## Approach
Let `nextDelay()` return 0 when the endpoint sends `Retry-After: 0`, instead of clamping to 1000 ms [research.md#F1]. The attempt cap stays, so a failing endpoint cannot spin [research.md#F2].

## Steps
1. Add a failing test: `Retry-After: 0` yields a 0 ms delay. Files: `test/retry.test.js`. Verify: `npm test -- retry` fails.
2. Pass the header value into `nextDelay()` and skip the clamp when it is 0. Files: `lib/retry.js`. Verify: `npm test -- retry` passes.
3. Check the three callers still get the old delay for other values. Files: `test/callers.test.js`. Verify: `npm test`.

## Files touched
- `lib/retry.js`
- `test/retry.test.js`
- `test/callers.test.js`

## Risks
- A zero delay on a failing endpoint can spin. Mitigated by the attempt cap kept in step 2.

## Test strategy
Criterion 1 maps to step 1 and 2. Criterion 2 maps to step 3. Tests are written first.
