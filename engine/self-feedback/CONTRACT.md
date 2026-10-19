# Self-feedback journal contract — `${DETENT_ROOT}/.local/self-feedback/journal.jsonl`

**This is NOT curator "feedback".** Curator feedback is a human answering a
gate — the human → agent direction, owned by `hooks/curator-pending-feedback-check.sh`.
The self-feedback journal is the reverse direction: an **agent** logging a
coverage gap it hit and could not resolve on its own, for a **human** to read
later. If you came here looking for "how do I leave feedback on a plan",
that's curator, not this file.

## What it is

**Why this exists / what it's worth:** see `README.md` (same directory) —
this file stays the normative contract, not the motivation.

- **Schema `self-feedback-v0`.** One JSON object per line in an append-only
  `.jsonl` file: `{schema, id, ts, area, kind, note, stage?, run_id?, source?}`.
- **Append-only.** Entries are never edited or deleted by the CLI. There is no
  `resolve`/`ack` verb in v0 — the journal is read-only history.
- **Agent-written, human-read.** `detent feedback add` is called by a stage,
  skill, or hook; `detent feedback list` (and herald's rollup, below) is how a
  human sees what accumulated.
- **Advisory. An entry NEVER blocks a stage, never opens a gate, and never
  networks.** Writing an entry has exactly one side effect: appending one line
  to a local file. It does not change `stage-status.json`, does not append to
  `decisions.json`, and does not call any connector. Contrast with the
  `access-degraded` gate (`engine/stages/CONTRACT.md`) and preflight blocked
  records — those already gate; this journal supplements them, it never
  substitutes for them.

## The three emission triggers

A stage/skill SHOULD (not MUST — nothing mechanically enforces this in v0)
append an entry when it hits one of these three named, recognizable coverage
gaps:

1. **Scout no-hit** — a query the research layer (`skills/scout/SKILL.md`)
   could not answer from any provider (every provider reachable but returned
   nothing relevant, or all providers blocked/partial). `--kind coverage-gap`.
2. **Respond stuck** — a bot/review comment the respond stage could not act on
   (no clear fix, ambiguous ask, needs a human call). `--kind workaround` or
   `--kind other`, `--stage respond`.
3. **Preflight blocked-source** — an `access-report.json` record classified
   `blocked` (`engine/sources/PREFLIGHT.md`). The journal entry is emitted
   **alongside**, never **instead of**, the access-degraded gate — the gate
   still hard-blocks a critical source; the journal entry is just the durable
   note that this happened, for later pattern-spotting. `--kind blocked-source`.

Nothing outside these three triggers is out of bounds — `--kind other` covers
anything else worth a durable note — but these three are the ones the rest of
the stack is wired to point at (see `engine/stages/CONTRACT.md`, PREFLIGHT.md,
`skills/scout/SKILL.md`).

## Honesty clause

`detent feedback add`'s output carries a `recorded` field. **Report it verbatim.**
- `recorded: true` — the append returned successfully; the entry is on disk.
- `recorded: false` — either the kill switch is on
  (`DETENT_SELF_FEEDBACK=off`) or the write failed. The file is untouched.

**Claiming an entry was journaled when the CLI returned `recorded: false` is a
contract violation** — the same class of failure as fabricating any other
`{ok:true}` result. If the write fails, say so; do not retry silently into a
fabricated success, and do not treat "I meant to log it" as equivalent to
having logged it.

## Kill switch

`DETENT_SELF_FEEDBACK=off` makes `add` a no-op: `{ok:true, recorded:false,
reason:"disabled via DETENT_SELF_FEEDBACK=off"}`, exit 0, journal file
untouched. There is no hook wired to this journal (see `engine/self-feedback/feedback.mjs`
header and the roadmap item's risk notes), so the `CLAUDE_JOB_DIR` hook
self-disable doctrine does not apply here — this is a pull-based, side-effect-
free-beyond-its-own-file CLI, not a hook.

## Reading it

`detent feedback list [--since <ISO>] [--area <a>] [--limit N=50]` returns entries
newest-first. Malformed lines are skipped and counted in `skipped_lines` —
never silently dropped without a count. Herald's morning brief also reads this
journal (`buildFeedbackSection` in `engine/herald/herald.mjs`) and surfaces new
entries in the window as ONE rollup `fyi` item — never one item per entry, to
keep the brief from becoming a firehose of low-signal notes.

## Deferred (explicitly out of scope for v0)

Rotation/compaction, dedupe/clustering of repeated gaps, surfacing in
`engine dashboard`, eval-harness integration (journal-driven test seeds), any
Stop/PostToolUse hook nagging about unjournaled gaps, auto-emit from
`engine.mjs` itself, and a `resolve`/`ack` verb. Emission stays SHOULD, not
enforced, so there is no hook here and thus no kill-switch/CLAUDE_JOB_DIR
surface to reason about beyond the CLI's own `DETENT_SELF_FEEDBACK=off`.
