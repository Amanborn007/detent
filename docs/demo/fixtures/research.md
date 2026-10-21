> Demo fixture: the files cited here are illustrative and are not in the throwaway repo.

# Research: acme/widgets#1

## Findings
- F1. KNOW. `lib/retry.js` clamps every computed delay to a minimum of 1000 ms. This is the drift in the ticket.
- F2. KNOW. Three callers use `nextDelay()`, and none pass a header value through.

## Existing help
- `lib/retry.js` `nextDelay()` is the one place to change.

## Risks
- A zero delay on a failing endpoint can spin. Mitigation: step 2 keeps the attempt cap.
