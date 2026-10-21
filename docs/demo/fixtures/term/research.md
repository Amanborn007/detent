# Research: acme/widgets#1

## Findings
- F1. KNOW. `retry.mjs` `retryDelay()` multiplies the header by 1000 and never special-cases 0.

## Blast radius
- `retryDelay()` is the only function in the repo that computes a delay.

## Risks
- A zero delay on a failing endpoint can spin. The attempt cap stays.
