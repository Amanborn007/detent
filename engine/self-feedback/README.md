# engine/self-feedback — how, why, and what it's worth

`CONTRACT.md` (same directory) is the normative contract — schema, honesty
rule, kill switch, the exact three emission triggers. This file is the
explainer: why the journal exists and what compounds because of it. Read
`CONTRACT.md` for the rules; read this for the motivation.

## How it works

One append-only `.jsonl` file, one JSON object per line, written by `detent
feedback add` and read by `detent feedback list` (and herald's morning brief).
A worked example line:

```json
{"schema":"self-feedback-v0","id":"sf-1731600000-a1b2","ts":"2026-07-14T09:03:11Z","area":"scout","kind":"coverage-gap","note":"no hit for knowledge-base query on regional webhook retries","stage":"research","run_id":"run-42","source":"stage"}
```

- **Store:** `${DETENT_ROOT}/.local/self-feedback/journal.jsonl` —
  append-only, gitignored (already covered by the existing `/.local/` root
  ignore).
- **Writers:** stages, skills, and hooks call `detent feedback add` at the three
  named triggers (see `CONTRACT.md`): scout no-hit, respond stuck, preflight
  blocked-source.
- **Readers:** humans, via `detent feedback list`, and herald's morning brief —
  `buildFeedbackSection` (`engine/herald/herald.mjs`) rolls every entry in
  the brief's window into ONE `fyi` item, never one item per entry.

## Why it exists

Agents routinely hit coverage gaps mid-run that they cannot fix themselves:
no knowledge source covers the query, a bot's ask is too ambiguous to act on,
a source preflight classifies as blocked. Without a durable channel, those
gaps evaporate the moment the session ends — and the next run hits the exact
same wall, with no memory that it happened before.

## Value add — compounding

Each gap becomes visible follow-up work instead of a silent dead end:

- Herald surfaces new entries the next morning, so a gap doesn't sit
  unnoticed until someone happens to hit it again.
- Repeated entries in the same `area` reveal a systemic gap — a single
  scout miss looks like noise, but five scout misses on one knowledge source over two
  weeks reveal a missing knowledge source that one-off fixes would never
  surface.

**End-to-end lifecycle example:** scout can't find anything on a query ->
`detent feedback add --area scout --kind coverage-gap --note "..."` journals it
-> herald's next morning brief surfaces it as an `fyi` rollup item -> a human
reads it and adds the missing knowledge source -> every future run that would
have hit the same wall now gets a real answer. The gap class is closed once,
for good, instead of being silently re-hit run after run.

## Boundaries

Advisory-only: an entry never blocks a stage, never opens a gate, and never
networks — its only side effect is appending one line to a local file. The
honesty rule on `recorded` (never claim an entry landed when the CLI reported
`recorded: false`) is load-bearing; see `CONTRACT.md` for the full rule
rather than duplicating it here.
