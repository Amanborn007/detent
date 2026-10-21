# Plan: acme/widgets#1

## Approach
Treat a `Retry-After` of 0 as an immediate retry in `retryDelay()` [research.md#F1]. The attempt cap stays.

## Steps
1. Add a failing test for `Retry-After: 0`. Files: `retry.test.mjs`. Verify: `npm test` fails.
2. Return 0 from `retryDelay()` for that header. Files: `retry.mjs`. Verify: `npm test` passes.

## Files touched
- `retry.mjs`
- `retry.test.mjs`

## Risks
- A zero delay can spin on a failing endpoint. Mitigated by the attempt cap.

## Test strategy
Criterion 1 maps to steps 1 and 2. Criterion 2 is covered by the existing tests.
