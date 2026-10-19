# Evidence and voice — the part that is identical on every surface

Read this before drafting anything a human reads: a curator artifact, a Slack message, an email, a
Jira or Confluence body, a PR description, a review comment, a ticket, a brief.

Two optional local files own **register per surface** and this one does not replace them:
`.local/voice.md` for artifacts, code comments and replies in chat, and
`.local/scribe-profiles.md` for Slack, email, GitHub, Jira and Confluence. What lives here is the
part that does not change between surfaces, so it is stated once instead of drifting across the
skills.

Binding on: `curator`, `scribe`, `referee`, `clerk`, `herald`, `scout`, `deslop`.

---

## The evidence ladder

Every claim carries how it was obtained. Strongest first:

1. **read it** — code at a named line, or a config value quoted from the payload
2. **ran it** — this is the output
3. **documented** — quoted from a page, with the page named
4. **reported** — a person said it, quoted, with who and when
5. **inferred** — reasoned to it, nothing observed

**Rungs 1 to 4 may be stated as verified. Rung 5 never sits with them.** An inferred claim goes in
its own place — *Not yet proven* in an artifact, "my read, not confirmed" in a message — with what
would settle it.

The failure this prevents is specific: a rung-five claim written in the grammar of a rung-one claim.
It reads identically to the reader and is wrong later. For example, "this function appears only in
tests" stated as fact from a grep whose output was truncated.

A search that did not run is never reported as a search that found nothing. Say which it was.

## Mechanism, not justification

Say what happens, not that it was chosen. **Banned as justification: `by design`,
`deliberately`, `intentionally`, `on purpose`, `per convention`.**

> `runs before the flag by design` → `runs before the feature flag is even loaded`

## Lead with the answer, or the ask

The first sentence is the answer, the recommendation, or what you need. Reasoning after, so the
reader can stop early. Never open with status or with a restatement of the question.

## One ask

If there are two, keep the one that actually blocks and put the rest on the ticket. This holds per
message and per artifact section, not per document.

## Numbers carry their caveat in the same sentence

`184 endpoints` alone misleads. `184 endpoints that received a retry — an upper bound, not failures`
does not. Never hedge a measured number, and never round away the caveat.

## Say the state in the sentence

No status pills, severity chips or badge rows on any surface. `DONE`, `BLOCKED` and a coloured tag
read as machine output. Write "what I would pick", not a green `OK`.

## Own the correction where it happened

When a later finding overturns an earlier one, say so at the top of the new version rather than
editing the middle quietly. In a thread, say which claim was wrong and what replaced it, then
continue — no apology spiral, no tally of past errors.

---

## Where the surface differs

| Surface | Length | Owned by |
|---|---|---|
| Curator artifact | long form expected; density is the failure, not length | `skills/curator` + `.local/voice.md` |
| Slack, email, Jira, Confluence, GitHub comment | 1–3 lines, hard cap | `skills/scribe` + `.local/scribe-profiles.md` |
| PR description | short, but exempt from the comment cap | `skills/referee` |
| Ticket body | the template in `skills/clerk/templates/` | `skills/clerk` |

Evidence and rationale that will not fit a capped surface go on the ticket or in the artifact, and
the message links to it. They are never dropped and never crammed in.
