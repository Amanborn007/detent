# Lexicon: one shared meaning per term, committed in the work repo

**Takeaway: the first time a run pins down what a domain term actually means,
it writes that meaning into `LEXICON.md` at the work repo's root, one or two
opinionated sentences per term. The file lives in the work repo because a
teammate reading that repo is who needs it; a central map at
`lexicon/LEXICON-MAP.md` in the detent clone tells a cross-repo run which
work repo's glossary to read.**

## Why a separate file, and why not `CONTEXT.md`

Detent already spends the word "context" on the context window, on context
load, on context pointers, and on the fresh-context review mandate. Naming the
glossary `CONTEXT.md` would collide with all four. `LEXICON.md` names the one
thing this file is: a shared vocabulary, not a context artifact.

## Where it lives

`LEXICON.md` sits at the **work repo's root**, alongside its own README, and
is **committed there** like any other product file.

A file kept in the detent clone instead would sit next to `.sdlc/` and
`.plans/`, both gitignored local state
([`../stages/CONTRACT.md`](../stages/CONTRACT.md)). A teammate cloning the
work repo, opening it in an editor with no detent install, or reviewing a PR
on GitHub would never see a glossary that lives somewhere else. A shared
vocabulary that only the detent clone can read is not shared.

## When it's created

`LEXICON.md` does not exist until the first term is resolved. No stage
scaffolds an empty `LEXICON.md` "for later". An empty glossary file is a
promise with nothing behind it, and it rots the same way an empty README
section does. The file is created, with its first entry, in the same edit
that resolves that first term.

## What a term entry is

One or two tight sentences stating what the term **is**, not what it does.
Where several words compete for the same idea in the codebase or the ticket
history, the entry is opinionated: it names the one that wins, so a later
reader does not have to re-derive which of three synonyms is the real one.

```markdown
## Retry window
The interval during which a failed delivery can still be retried without
manual intervention. Not the same as the delivery SLA.
```

## What does not belong in an entry

- **Implementation detail.** Which function reads the value, which table
  stores it, which flag gates it, that lives in the code and in commit
  messages, not in a definition of what the term means.
- **General programming concepts.** A term entry exists because the word is
  specific to this domain. "Idempotency key" earns an entry if the domain
  gives it a specific shape; "retry" on its own does not.
- **A decision dressed as a definition.** "We chose to store retry
  windows in UTC" is a decision, with its own trail (a ticket, a PR, a
  decision log). A term entry says what the word means, not what was decided
  about it.

## Who writes an entry, and when

Terms are added **in the pass that resolves them**, the stage or run that
first pins down what the word means for this repo. They are never batched for
a later cleanup pass: a term parked "to add to the lexicon later" is a term
that stays ambiguous for everyone who touches the repo in between.

## The central map: `lexicon/LEXICON-MAP.md`

Detent keeps one line per work repo at `${DETENT_ROOT}/lexicon/LEXICON-MAP.md`
(the detent clone root, a sibling of `.sdlc/` and `.plans/`, not under
`engine/`). A run that touches more than one repo (the multi-workspace case in
[`../stages/CONTRACT.md`](../stages/CONTRACT.md)) reads this map first to resolve which repo's
`LEXICON.md` applies to which part of the change, instead of guessing from the
current working directory.

The map itself is committed in the detent clone: it is the cross-run index,
not run state, and it stays useful across every clone reinstall. Other files
that land under `lexicon/` in the clone (a cached copy of a work repo's
`LEXICON.md`, pulled in so a run can read it without a second checkout) are
local working copies, not the source of truth, and are gitignored the same way
`.sdlc/` and `.plans/` are. See `.gitignore` at the clone root.

## Forbidden failure modes

- **Lexicon in the detent clone instead of the work repo.** This is the
  mistake this design exists to prevent: a glossary that only the detent
  clone can read is invisible to a teammate reading the work repo, which
  defeats the point of a shared vocabulary.
- **A term added before it is settled.** An entry written while the meaning
  is still being argued over locks in a guess as if it were resolved; wait for
  the pass that actually resolves the term.
- **A definition that restates the implementation.** "Retry window: the
  value returned by `getRetryWindow()`" tells the reader nothing they
  could not already read in the code, and it goes stale the moment the
  function is renamed.
- **An empty `LEXICON.md` scaffolded ahead of need.** Creating the file before
  there is a first entry to put in it is the same failure as an empty README
  section: a promise with nothing behind it.
- **Batching term entries into a later cleanup pass.** A term parked for
  later is a term every reader in between has to re-derive for themselves.
