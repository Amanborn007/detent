# NEW-TEAM-ONBOARDING

Repeatable procedure for profiling a team you have never worked with.
Covers your own team, a sister team and an external dependency team. Read-only everywhere: create nothing in
Jira/Slack while profiling. Output schema: [TEAM-PROFILE-TEMPLATE.md](TEAM-PROFILE-TEMPLATE.md).

**Two-layer note:** this procedure mines the **STORED layer only** (ways of
working: cadence, conventions, cycle times, intake rules). DYNAMIC fields —
roster, timezones, service ownership, team channel — are *used* during
mining to know where to look, but are fetched live per the template's
DYNAMIC query table and are **never written into the profile**. The one
identity key the profile keeps is the team slug (the DYNAMIC queries' input).

## Time budget (typical)
- Minimum viable profile: **~15–20 min** of tool time per team.
- Full profile (all sections incl. cycle-time stats): **~30–45 min** per team.
AI-assisted this compresses hard; the bottleneck is reading/verifying, not fetching.

## Step 0 — Decide the team is worth profiling
Profile a team when you will (a) hand them work, (b) depend on their reviews or
sign-offs, or (c) estimate work that lands in their systems. Skip teams you
merely observe.

## Step 1 — Discovery: prove which teams you actually touch (10 min)
1. JQL: `(assignee = currentUser() OR reporter = currentUser()) AND updated >= -90d`
   — bucket results by project key; count distinct collaborators (assignees or reporters
   who are not you).
2. Slack: search `from:<you> after:<90d ago>` — bucket by channel.
3. A team qualifies as a pilot when it shows up in **both** sources
   (tickets + a channel you actually post in). Beware two traps:
   - customer or vendor names are not internal teams. A shared external channel is not a team channel;
   - a project key you own solo is your *work*, not a team — the team is whoever
     answers you in its channels.

## Step 2 — Source order per team (do them in this order; each narrows the next)
1. **Channel census** (2 min): search channels by the team/project name; classify
   each hit (working / comms / alerts / external). Note creators — channel creators
   are usually the coordinator or lead.
2. **Read the working channel, newest ~50–100 messages** (10 min): this yields
   80% of the profile — standup rhythm, review protocol, deploy norms, who answers
   what, escalation format, absence norms. Read *pinned/bot messages* carefully:
   intake bots encode the team's official process better than any wiki.
3. **Jira project scan** (10 min): two queries —
   - `project = <KEY> AND updated >= -30d` for conventions (types, states,
     priorities, labels, title prefixes, who reports/triages);
   - `project = <KEY> AND resolved >= -60d` for cycle times (created→resolved
     per issue type; note the WON'T-DO rate — it tells you how they treat
     superseded work).
   Results blow past token limits — dump to file and aggregate with jq/awk,
   don't read tickets one by one.
4. **Timezone lookups** (3 min): Slack profile lookups for the 3–5 names that
   dominate the channel. Cross-check profile timezone against posting hours;
   when they conflict, record the conflict — do not guess.
5. **Optional depth**: read one escalation thread end-to-end to capture the
   escalation path in their own words; read the external channel only to note
   it exists (never quote it into the profile).

## Step 3 — Write the profile
Use [TEAM-PROFILE-TEMPLATE.md](TEAM-PROFILE-TEMPLATE.md). Write to
`${DETENT_TEAM_PROFILES:-<detent-clone>/.local/team-profiles}/<team-slug>.md`
— LOCAL ONLY, gitignored, never committed (see
[`teams/README.md`](../../../teams/README.md)).
Fill the minimum viable profile first, then extend. Date-stamp everything you
can ("observed <date>"), because freshness decides trust.

## Step 4 — Know when to just ask the team
Mining stops paying off quickly for:
- **estimation style** (points vs gut vs decomposition) if not visible in tickets;
- **SLAs** they consider official;
- anything behind private channels you're not in;
- per-state dwell times (needs changelog access — usually not worth it).
For these, one message to the lead/coordinator ("what's your preferred intake
path and turnaround expectation for X?") beats an hour of archaeology — and
starting the relationship with a direct question is itself operationally useful.
Ask *after* the mining pass so your questions are specific.

## Failure modes seen in practice
- Search-result timestamps can be garbled — trust channel reads over search hits.
- MCP Jira results overflow context: always aggregate via file + jq, request few fields.
- Private channels appear in search but read empty/partial — note the gap instead
  of padding the profile.
- A program manager who posts everywhere can look like an engineer in raw counts.
  The *content* of their messages (access grants, customer comms, routing) reveals
  the role.
