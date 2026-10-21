# Brief: Amanborn007/detent-demo#1

## Goal
Callers can cap how long a slug gets, and the cap never leaves a half word or a dangling separator.

## Acceptance criteria
- [ ] `slugify(input, { maxLength })` returns a string of at most `maxLength` characters (from ticket)
- [ ] The cut lands on a separator, so no word is split (from ticket)
- [ ] When the first word alone is longer than `maxLength`, that word is cut at `maxLength` (from ticket)
- [ ] The result never ends in the separator (from ticket)
- [ ] `maxLength` below 1, or not an integer, throws `RangeError` (from ticket)
- [ ] Calls without `maxLength` return exactly what they return today (from ticket)
- [ ] Tests cover each criterion above (from ticket)

## Constraints
- Node 20 or later, ES modules, no dependencies (`package.json` `engines` and `type`)
- Tests run with `node --test` (`package.json` `scripts.test`)
- The custom `separator` option already exists, so the cut has to work for any separator, not only `-` (`src/index.js`)

## Affected repo(s)
- Amanborn007/detent-demo: the ticket is filed there and `slugify` lives in `src/index.js`

## Unknowns & open questions
U1: The ticket does not say what `maxLength: undefined` or `maxLength: null` means. `undefined` reads as "option not given". `null` could mean "no cap" or could be "not an integer" and throw. (-> D-001)
    Options: treat null like undefined (no cap) / throw RangeError on null.
    Why it matters: it decides whether a caller passing `null` from a config file gets a slug or an exception.

## Source
- Ticket: Amanborn007/detent-demo#1
- Fetch: `detent socket call ticket` (gh-ticket adapter), full body from `gh issue view 1 -R Amanborn007/detent-demo`
- Fetched: 2026-10-20T15:10:52Z
