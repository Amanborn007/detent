---
name: examiner
description: >-
  Interview me about a plan or decision until every question that can be
  answered now has been asked. You decide when to stop.
disable-model-invocation: true
---

# examiner — interview me until the open questions are gone

The protocol is [`engine/examiner/PROTOCOL.md`](../../engine/examiner/PROTOCOL.md). Read it
and follow it. This skill is the standalone entry point; clerk and the plan stage reach
the same protocol by path.

**User-invoked on purpose.** It carries `disable-model-invocation: true`, so it costs
nothing on a turn where you did not ask for it, and no other skill can fire it at you
mid-task. Callers that need the discipline reach the protocol doc directly rather than
invoking this.

**What you get.** One curator artifact per round. Every question on it is answerable
right now, each one shows what I would pick and why, and each one names what breaks if
it is guessed wrong. Answering a round is a pass of clicks, not a conversation.

**What it will not do.** Ask you anything git, the filesystem or `gh` could answer;
those go to a subagent. Answer its own questions. Decide the interview is over: every
round ends by naming what is still open, and you call it, not me. When you do, whatever
is left gets recorded as a call I made, with the consequence if I made it wrong.

**Outside an engine run** the answers land in the caller's working note. **Inside one**
they land in `decisions.json` as `kind: "examiner"` blocks and ride the host stage's
existing gate, so a successor session sees what you settled instead of asking again.
