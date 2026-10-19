# examiner — the frontier protocol

Detent already has the asking machinery: pending decision blocks in `decisions.json`
and a human answering them in curator. What it has no rule for is **which** questions
to ask, **when**, and in what batch. Ambiguity today is filed one block at a time,
whenever a stage happens to notice it, so a human is interrupted once per noticing.

This is that rule. Callers reach it by path, the way both clerk and engine research
reach [`engine/sources/PREFLIGHT.md`](../sources/PREFLIGHT.md).

Adapted from the `grilling` skill in `mattpocock/skills`.

## The design tree and the frontier

Model the open questions as a **design tree**. Every decision branches into the
decisions that hang off it.

The **frontier** is every question whose prerequisites are already settled, the ones
answerable now without guessing at an answer you have not heard yet. A question whose
answer depends on another question still open belongs to a **later round**, not this
one.

## A round

Ask the whole frontier at once, in one render. Never one question at a time.

Each question carries the agent's **recommended answer**, and where it sits is the
middle ground between two failures.

A `recommended:` line with no other signal makes the reader hunt for which option it
meant. A bare recommendation rendered as the first option invites a reflex click and
turns self-answering into a one-line slip, and an agent answering its own question is a
contract violation ([`engine/stages/CONTRACT.md`](../stages/CONTRACT.md), "An agent
never answers its own question").

So: the reasoning goes above the options as a non-interactive `recommended:` line, and
the option it points at **carries the marker inside its own label**, the way this
harness already marks a recommended choice. One click still settles the question,
nothing is pre-selected, and no option is privileged by position.

The rule that holds regardless: an answer is only an answer when it arrived as a human's
click. The agent writes no `answer` field, whatever the render looks like.

**Facts are the agent's job. Decisions are the human's.** Anything the environment can
answer goes to a subagent. Never ask a human something the filesystem, git, `gh`, or a
socket could have told you. A running lookup is an unsettled prerequisite, so it holds
back only the questions downstream of it. Ask the rest of the frontier now rather than
blocking the round on it.

Every fact a subagent brings back carries its rung on the evidence ladder
([`docs/evidence-and-voice.md`](../../docs/evidence-and-voice.md)). An **inferred**
fact does not settle a prerequisite. It becomes a question.

## Admission bar

A question earns a slot only if it has a named **consequence-if-wrong**: what breaks,
or what gets built wrong, if the answer is guessed. A question without one is the agent
thinking out loud. Drop it.

## Who decides it is done

There is no round cap. The human decides when to stop, and the agent never decides it
for them.

The problem this replaces is real, so it is solved a different way. "Done when the
frontier is empty" has no terminator, because the agent both grows the tree and judges
it empty, which lets it declare victory by narrowing. So **every round ends by stating
what is still open**: the questions already on the tree, and the fog it can see but
cannot yet phrase. The human reads that and either asks for the next round or calls it.

When they call it, every still-open question is recorded with its consequence-if-wrong
as a `(PLAN CALL)` ([`engine/stages/plan/SKILL.md`](../stages/plan/SKILL.md)) or the
caller's equivalent, and the work proceeds on those calls.

The agent may say a further round looks unnecessary. It may not stop on that judgment.

## Where the answers live

**Inside an engine run**, real decision blocks appended to `decisions.json` with
`"kind": "examiner"` and `"blocks": ["implement"]`. Never a ledger that lives only in the
artifact. A gate is file state, not a conversational promise, and questions kept out of
`decisions.json` skip `rejected_options` and `decision-rationale.jsonl`, so the next
session relitigates every one of them.

`blocks: ["plan"]` makes `engine stage end` refuse, which fires an episode boundary and
parks the run. Use it only when the answer genuinely invalidates planning.

Grill runs **before** the host stage's gate and folds its questions into that stage's
single render and single poll. It never opens a curator session of its own.

**Outside a run** (clerk stage 0, standalone `/examiner`), answers land in the caller's own
working note, for clerk carrying its `exercise_state`. Never a third ledger.

## The render

One `data-plan-question` per frontier question, each option a `data-plan-option`, the
recommendation as prose above them. Curator mechanics are delegated to subagents
([`skills/curator/SKILL.md`](../../skills/curator/SKILL.md) §0).

If the human ended the session before the next round, do not reopen it. Round N+1 is a
new artifact keyed to the same slug, its change log carrying what earlier rounds
settled.

## Forbidden failure modes

- **Self-answered round.** Writing an `answer` that did not arrive from a human's
  curator click. Rendering the recommendation as the first clickable option is the same
  violation one step removed.
- **Asking a fact.** Any question git, the filesystem, `gh`, or a socket could have
  answered.
- **Serial questions.** One question per round, so the human is interrupted N times for
  a tree that fits in three.
- **Unbounded rounds.** A fourth round in place of a recorded `(PLAN CALL)`.
- **A parallel ledger.** Grill questions living only in the artifact, invisible to
  `decisions.json` and to the successor session.
- **Round-cap laundering.** Rewording an open question as settled to reach an empty
  frontier.
- **A second poll.** Opening a curator session while the host stage already has one.
