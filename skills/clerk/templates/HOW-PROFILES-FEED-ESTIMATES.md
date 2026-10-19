# HOW-PROFILES-FEED-ESTIMATES

How clerk consumes a team profile (schema:
[TEAM-PROFILE-TEMPLATE.md](TEAM-PROFILE-TEMPLATE.md)) when scoring approaches
and producing estimates. Each mapping below is profile-section → concrete
adjustment, with the real-world pattern that motivated it.

## 1. Timezone overlap → review & unblock latency
From: People — the **DYNAMIC** roster + timezones fetched at use-time
(get_team_members on the team slug, Slack profile lookups), never a stored
table; see the DYNAMIC query table in the template.
- Same-timezone team (e.g. everyone within two hours of each other): review turnaround is same-day;
  a 3-PR change costs ~1–2 elapsed days of review latency. Estimate serial
  review chains optimistically.
- Zero-overlap team (author and reviewers with no working hours in common): every review
  round-trip costs **one working day minimum**, regardless of diff size.
  Estimate = implementation time + (expected review rounds × 1 day). Prefer
  approaches that minimize round-trips: one well-evidenced PR over a stack,
  testing evidence attached up front (if their intake bot flags "missing
  testing evidence", pre-empt it).
- Ambiguous/split coordinator timezones: schedule asks to hit the *observed*
  posting window, not the profile timezone.

## 2. Intake mechanism → how to route work (and what it costs to skip)
From: Channels & intake mechanisms.
- If the team has a formal intake (daily PR thread, office hours, intake ticket
  type): the estimate must include the *cadence quantum* — e.g. a weekly office
  hours slot means a design question answered in 0–7 days; a daily PR thread
  means posting after today's thread costs a day.
- Office-hours rules matter: "cancelled if no sign-ups by 9:30" means the
  fallback path (channel post) should be planned, not discovered.
- Escalation path in the profile tells you the fast lane for launch-blocking
  work: route via the coordinator role with an explicit two-part ask
  ("who owns this / do you want a ticket"), which observed teams answer faster
  than open-ended posts.

## 3. Ticket conventions → decomposition granularity of the plan
From: Jira conventions.
- Match their prefixes/types or the work won't triage: for a team that
  runs `[feature] / [blocked] / [fix]` + numbered subtasks, clerk
  should emit that shape — a monolithic story will sit in triage.
- If the team runs "waiting on another team or a product answer" states: model
  blocked items as **separate tickets with wait-state risk**, not as
  subtasks of build work. Their cycle-time tail (for example Tasks avg ~30d, max ~90d,
  dominated by waits on other teams) is the empirical prior for anything
  externally blocked.
- If the team shows no story points: give estimates in decomposed-task counts
  and elapsed ranges, not points; points would be noise to them.
- A high won't-do rate (for example ~20%) is healthy supersession — plan for
  scope-shedding checkpoints rather than treating every opened ticket as
  committed work.

## 4. Cycle-time stats → elapsed-time priors per issue type
From: the team profile's Cycle times section — interpretation STORED, the
raw actuals **DYNAMIC-fetchable via JQL** at use-time (query shape in
[TEAM-PROFILE-TEMPLATE.md](TEAM-PROFILE-TEMPLATE.md) § DYNAMIC table:
per-issue-type created→resolved actuals over the trailing window). Prefer a
fresh fetch over the profile's stored numbers whenever Jira is reachable;
cite whichever you used ("cycle times via JQL fetch <date>" vs "profile
<date>").
- Use per-type avg as the prior for *elapsed* (not effort) time, and the max as
  the risk bound. Quote both: "effort ~2 dev-days; elapsed prior for this team's
  Task type is ~4 weeks, tail driven by waits on other teams."
- Distinguish effort-bound teams (a co-located team shipping same-week once reviewed)
  from wait-bound teams (a team gated on another team's releases): AI assistance
  compresses the former a lot and the latter barely — say so in the estimate.

## 4a. The two-number rule — human-baseline AND AI-assisted (required)

Every estimate clerk outputs — per ticket and per epic milestone —
carries **two numbers, never one**:

1. **Human-baseline** — the traditional estimate: implementation effort in
   the project's own unit, elapsed prior from the team's per-type
   cycle-time actuals (§4).
2. **AI-assisted** — the realistic estimate given agent-assisted
   implementation, with a one-line note on what drove the gap.

Both carry a basis line; the AI-assisted number is NOT a flat multiplier on
the baseline — stratify:
- **Effort-bound work shrinks a lot** (greenfield build, boilerplate,
  well-specified features): re-anchor on spec + review + integration, not
  coding time — implementation is the cheap part.
- **Wait-bound work barely moves** (answers from other teams, cross-team
  sign-offs, review queues, release trains): the cycle-time tail is
  human/external and survives AI assistance intact. Say so explicitly.
- Gnarly debugging in mature code and unclear specs may not shrink at all —
  flag those honestly rather than throwing out a rosy number.

**Calibration evidence:** an estimate made with a single number and no
AI-velocity prior ran **5–10x over** the actuals. All implementation PRs
were opened the SAME DAY the stories were decomposed (AI-assisted build
effort ≈ 1 day per story), while everything after that sat wait-bound
(review, cross-team sign-off, a pending spec). The two numbers exist precisely so a reader sees both "what a human team
would book" and "what will actually gate delivery".

## 5. Release/deploy conventions → rollout timing
From: Decision-making / Release cadence.
- Release-train teams (mobile release candidates with a regression-check phase and
  per-train integration labels): landing after the RC cut costs a full train cycle. The estimate must
  pin the target train, not just the merge date.
- Gate-based teams (feature-flag gates, golden-file diff checks in CI, security
  sign-offs before deploy): add the named sign-off as an explicit dependency with
  an owner-role, and prefer dark-launch/flagged approaches because the profile
  proves the team already works that way.
- Deploy-announcement norms tell you verification cost: a team that posts
  diffs per deploy expects you to do the same for changes in their repos.

## 6. Standup fluidity → synchronization assumptions
From: Response patterns.
- Fluid standups (moved/cancelled ad-hoc) mean decisions happen in-channel:
  don't gate plan steps on "raise at standup" — post async with @role instead.
- Recurring automated digests (e.g. an automated blocker digest every 1–2
  days) are the team's status heartbeat: schedule status-dependent steps just
  after the digest cadence, and feed the digest rather than duplicating it.

## 7. Approach scoring (roll-up)
When clerk scores candidate approaches, profile-derived multipliers apply to:
- **coordination cost** = f(timezone overlap, intake cadence, review protocol);
- **elapsed risk** = f(cycle-time tail, wait-state prevalence, release train);
- **acceptance probability** = f(conformance to ticket conventions, evidence
  norms, flag/gate culture).
An approach that is 20% more implementation effort but avoids a zero-overlap
review chain or a missed release train usually wins on elapsed time — the
profile is what makes that tradeoff computable instead of vibes.

## Freshness rule
Estimates must cite the profile date they used. If the profile is >90 days old
or predates a known reorg, clerk flags the estimate as running on stale
team intelligence and the affected multipliers revert to neutral.
