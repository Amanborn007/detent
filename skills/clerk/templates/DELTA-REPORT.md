# DELTA-REPORT template (clerk DELTA MODE)

Used when RESEARCH finds the requirement **partially (or fully) built or
ticketed**. Instead of a full decomposition, clerk produces this report:
an existing-work map, a per-element classification, and drafts for ONLY the
genuine delta. The format exists to produce zero duplicate drafts and to surface the
genuine delta.

**Prime directive:** in delta mode the failure you are preventing is
*duplicate creation*. Every "missing" claim must be backed by the recorded
query that failed to find it; every "exists" claim must carry a merge state
you verified this run.

---

## File skeleton

```markdown
# DELTA-REPORT — <requirement slug> (clerk, <date>)

**Verdict:** <fully ticketed | partially ticketed | effectively unticketed>
— one paragraph: which epic/tickets already carry this requirement, what
fraction of the requirement they cover, and how many genuine delta items
exist. If the requirement IS an existing issue verbatim, say so and name it.

## 1. Existing-work map (keys, PRs, merge states — all verified this run)

| Requirement element | Existing ticket | Ticket status | PR(s) | PR merge state | Classification |
|---|---|---|---|---|---|
| <element from the requirement> | <KEY> | <status verbatim> | <repo#PR or —> | <OPEN / MERGED / CLOSED-unmerged / —> | built / in-flight / unticketed |

Notes row(s): superseded PRs, blocked dependencies, cross-team tickets in
other projects — anything that explains the map.

## 2. Genuine delta → drafted

| Draft | Type | Why it is not a duplicate (cite the queries) | Effort class |
|---|---|---|---|
| <drafts/<file>.md> | <Bug/Task/...> | <the JQL/gh/CQL queries that prove no ticket and no PR covers it> | small/medium/large+ |

## 3. Comment-proposals (NOT new tickets — proposed, never posted without the gate)

**COMMENT-1 → on <KEY>** (proposal): <the comment text, ready to paste>
...

## 4. Explicitly NOT drafted (and why)

- <thing a naive run would have drafted> — <duplicate of KEY / tracked inside
  KEY / out of scope in both requirement and epic / already in another
  team's queue as KEY>.
```

---

## Rules

### Classification — every requirement element gets exactly one

- **built** — the work is merged/deployed (or the deliverable is Done and
  verified). An open PR is NOT built. "Code-complete in open PRs" is
  in-flight — the detection arm's key finding was an epic that was
  "built, dark, under review": nothing merged, everything OPEN.
- **in-flight** — a ticket exists and is open/in-progress, or a PR exists
  but is unmerged. Verify the merge state yourself this run (`gh pr view`,
  or check the target branch's tree) — never trust a ticket's status field
  alone for "built".
- **unticketed** — no ticket and no PR covers it, proven by recorded
  queries (JQL text-search on the distinctive terms, gh code/PR search).
  This is the only class that may produce a new ticket draft.

### Drafting discipline

- Draft new tickets ONLY for **unticketed** elements. Each draft follows
  [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md) in full (including the required
  `Repo scope:` line and the two-number estimate).
- **in-flight** elements get comment-proposals at most: a disposition ask,
  a status roll-up, or a "this prerequisite is tracked where?" question,
  written ready-to-paste in section 3. Comment-proposals go through the
  ticket gate like drafts — **never posted without a recorded `approve`**.
- **built** elements get nothing (at most a line in section 4).
- Open items living as prose INSIDE an in-flight ticket stay there —
  splitting them into new tickets mid-review forks tracking; propose a
  comment instead if they risk silently dropping.

### Evidence discipline

- Every cell in the existing-work map cites work you fetched this run.
  Merge states dated: the map is a snapshot, say when it was taken.
- Every row in section 2's "why not a duplicate" column names the exact
  queries (from the working note) whose no-hit proves absence. A delta
  claim without its no-hit queries is fabrication (skill invariant 3).
- Section 4 is mandatory: listing what you deliberately did NOT draft is
  how the gate reviewer distinguishes restraint from blindness.

### Gate flow in delta mode

Both gates still run. The approach gate presents the verdict + map (the
"approach" options collapse to: accept delta-only / dispute the map /
full decomposition anyway). The ticket gate presents this report plus the
full text of every delta draft and comment-proposal; `approve` covers
posting the approved comments as well as creating the approved tickets.
