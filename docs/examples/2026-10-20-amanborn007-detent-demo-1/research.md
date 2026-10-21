# Research: Amanborn007/detent-demo#1

## Method
- Access preflight: all 4 sources reachable (target repo, ticket, repo docs, GitHub search). See `access-report.json`.
- knowledge / repo-docs: "slugify" (3 hits, README.md), "separator" (0), "length" (0), "truncate" (0).
- skill-discovery: no `skill-discovery` socket in stack.yaml, so it was not called.
- repo: `git log --oneline` (1 commit), `git log --grep slug`, `git log -S separator`, read `src/index.js` and `test/slugify.test.js` in full.
- gh: `gh pr list -R Amanborn007/detent-demo --state all --search slug` (0), `gh search code maxLength --owner Amanborn007` (0).

## Findings
F1 KNOW [repo: src/index.js:7-17] `slugify` lowercases, strips accents, replaces each run of non-alphanumerics with `separator`, then trims leading and trailing separators with a regex built from `escape(separator)`.
F2 KNOW [repo: src/index.js:12] `separator` defaults to `-` and can be any string, including more than one character. A cut "at a word boundary" has to look for the separator string, not a single `-` character.
F3 KNOW [repo: src/index.js:8-10] Bad input already throws `TypeError` for a non-string `input`. The ticket asks for `RangeError` on a bad `maxLength`, so the two error types will sit side by side.
F4 KNOW [repo: test/slugify.test.js] 5 tests with `node:test` and `assert/strict`, one behaviour per test. New tests fit the same file.
F5 KNOW [repo: git ab71561] The repo has one commit, so there is no precedent change to copy.

## Blast radius
- Touched: `slugify` in `src/index.js` (new option, applied after the existing trim) [repo: F1]. KNOW.
- Consumers: the test file and the README example only [repo: grep]. No other repo uses it [gh search code: 0 hits]. KNOW.
- Schemas and contracts: the options object gains `maxLength`. The return type stays `string`. The JSDoc `@param` for options must list it [repo: src/index.js:3]. KNOW.
- Events and queues: none. It is a pure function. KNOW.
- 1-hop neighbors: upstream is only `String.prototype` methods and the local `escape` helper. Downstream is the test file and the README. KNOW.

## What could help that already exists
- The trailing-separator trim in F1 can run again after the cut, which gives "never ends in a separator" for free. It might not fit if the cut leaves a partial separator, which can only happen with a multi-character separator.
- `escape()` in `src/index.js` already makes the separator regex-safe.
- Nothing else found: searched the README, git history and GitHub code search (see Method).

## Unknowns after research
U1 still open (D-001). The code gives no hint about `null`. Treating `null` like `undefined` would match how `separator` uses `??` [repo: src/index.js:12], which is a GUESS about intent, not a fact.

## Risks & gotchas
R1 KNOW [repo: src/index.js:12] With a multi-character separator such as `--`, cutting at `maxLength` can leave a half separator (`a-`). The cut must back up to a whole separator.
R2 KNOW [repo: src/index.js:20] The local function `escape` shadows the global `escape`. It is harmless, but a new helper must not reuse the name.
