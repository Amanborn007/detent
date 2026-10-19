# TEAM-PROFILE-TEMPLATE

Standard schema for the team intelligence clerk consumes when scoring
approaches and producing estimates for work that touches a team.

## Two layers: every field is DYNAMIC or STORED

Every field in this schema carries exactly one marker:

- **DYNAMIC** — fetched live at use-time, on every run, and **never stored**
  in the profile file. Who is on a team, what services they own, and where
  they talk all go stale silently; fetching live is the only freshness
  guarantee that works. Each DYNAMIC field below states its exact query and
  fallback order — if every source in the chain fails, report the gap; never
  substitute a remembered or stored answer.
- **STORED** — mined ways-of-working only: cadence, conventions, cycle
  times, escalation habits. Facts that change slowly and cannot be pulled
  from a live API. Only STORED fields are ever written to the profile file.

## Storage & hygiene for the STORED layer (non-negotiable)
- Profiles live at `${DETENT_TEAM_PROFILES:-<detent-clone>/.local/team-profiles}/<team-slug>.md` — **LOCAL ONLY, never committed to any repo**. They describe colleagues; only this template ships. (Rationale: [`teams/README.md`](../../../teams/README.md) at the detent repo root.)
- Confirm the directory is un-committable before writing: the in-clone default must be gitignored (`git -C <detent-clone> check-ignore -q .local/team-profiles` must succeed); an override path must be outside every git worktree (`git -C <dir> rev-parse` must fail) or ignored.
- **Guardrail — factual and operational only.** Allowed: channel functions, cadence, conventions, roles observed *as roles* (lead/EM/triager), observed SLAs, workflow states, cycle-time numbers. Forbidden: any subjective judgment about a person's performance, speed, competence, or the team's culture quality. If a sentence could not be defended by pointing at a message or a ticket, it does not go in.
- **No DYNAMIC data in the file.** Rosters, timezones, service lists, and channel IDs are fetched per run; writing them down creates the stale copy this two-layer split exists to kill.
- Every STORED claim should be traceable to a source you actually read (a channel, a JQL result). Mark inferences as inferences and ambiguities as ambiguous — never resolve a gap by guessing.

## DYNAMIC fields — exact query + fallback order (fetch at use-time, never store)

| Field | Primary query | Fallbacks (in order) |
|---|---|---|
| **Membership (roster + GitHub handles)** | GitHub org teams API: `get_team_members` (GitHub MCP) on the team slug — equivalently `gh api orgs/$ORG/teams/<team-slug>/members` (`$ORG` is `org.github_owner` from your config). The GitHub team slug is the authority for membership. | 1. optional org directory lookup by team slug (only if your stack has one) → 2. Slack `slack_list_channel_members` on the team channel → 3. ask the lead; report which rung answered. |
| **Member timezones** | Slack `slack_read_user_profile` per member from the live roster (cross-check against observed posting hours; record conflicts, don't guess). | 1. org directory timezone field, if one is configured → 2. observed posting-hours inference, marked as inference. |
| **Service ownership (which services/repos the team owns)** | The service manifest at the repo root (whatever file your org uses to declare a service's owning team and contact channel). Enumerate by searching org repos for the team (`gh search code --owner $ORG "owner: <TEAM>" --filename <manifest-file>`). | 1. org directory service→team mapping, if configured → 2. CODEOWNERS of the repo → 3. ask in the team channel. |
| **Team Slack channel** | The team/contact channel declared in the service manifest's metadata (alongside the owner field); confirm the channel exists via `slack_search_channels`. | 1. `slack_search_channels` by team name and classify hits → 2. org directory team page, if configured → 3. ask a member from the live roster. |
| **Richer org data (reporting line, team→org placement, manager role, adjacent teams)** | Optional org directory lookup by team slug, if your stack has one; query the team's page per field needed. | 1. GitHub `get_teams` parent/child relationships → 2. Slack workspace directory → 3. mark unknown; do not infer org structure. |
| **Cycle-time actuals (per issue type: created→resolved)** | JQL per type over the trailing window: `project = <KEY> AND issuetype = <T> AND resolutiondate >= -180d` with fields `key, created, resolutiondate, status` (fields-limited, maxResults ≤ 50 per page) → compute n / avg / max per type. | 1. the profile's STORED cycle-time numbers, cited with their profile date and flagged as the stale-prone fallback → 2. no data: say "no cycle-time prior", never guess. |

Every estimate or routing decision that used a DYNAMIC field cites the fetch
("roster via get_team_members, <date>"), exactly as STORED facts cite the
profile date.

## Required header block (STORED)
```
# Team Profile: <Team name> (<Jira key / informal name>) — STORED layer only
- **Profile date:** YYYY-MM-DD (data window: <start> → <end>)
- **Sources:** <exact channels w/ IDs, JQL queries used for the mined facts>
- **Relationship to <owner>:** <own team | second team | external dependency> + one line why (a slug listed in `user.teams` in `detent.user.yaml` is an own team)
- **Team slug(s):** <slug> — the ONLY identity key kept here, so the DYNAMIC
  queries above have their input; everything the slug resolves to is fetched live.
```
The **profile date + data window** double as the freshness stamp for the
STORED facts. Treat them as STALE after ~90 days or after a known
reorg/ownership change — re-mine before relying on them for an estimate.
(DYNAMIC fields have no staleness: they are re-fetched every run.)

## Required sections (in order)

### 1. Identity — mixed
- Jira project key(s), Confluence space(s), alert routing keys: **STORED**
  (slow-moving, mined once, re-verified on staleness).
- Systems/repos/services owned: **DYNAMIC** — resolve per the ownership row
  above; the profile may note "owns the delivery pipeline" as context,
  but the authoritative service list is fetched live.

### 2. People — DYNAMIC roster, STORED observations
- Roster, GitHub handles, timezones, team timezone spread: **DYNAMIC** (rows
  1–2 of the table above). Do not keep a name/timezone table in the file.
- Observed functions — ways-of-working facts like "the lead triages intake
  daily", "deploys are announced by the on-call": **STORED**, phrased as
  roles, each traceable to a message/ticket. No evaluations.

### 3. Channels & intake mechanisms — DYNAMIC identity, STORED behavior
- Which channel is the team's front door / working channel / alerts:
  **DYNAMIC** (row 4). Channel IDs are not stored.
- The intake *mechanism and its rules* (daily PR-review thread, office hours
  and their cancellation rule, intake bots and their schedule): **STORED** —
  this is mined process knowledge the API cannot give you.

### 4. Response patterns / cadence — STORED
Standup/meeting rhythm (and how fluid it is), sync vs async default, observed
response latencies with dated examples, how leave/absence is communicated,
recurring automated posts (digests, reminders) and their frequency.

### 5. Jira conventions — STORED
Issue-type hierarchy actually used; summary/title conventions (prefixes, tags);
workflow states *as observed* including special states; priority scheme;
estimation style (points, decomposition granularity, or none observed);
labels in use; who triages (as a role).

### 5a. Cycle times — DYNAMIC actuals, STORED interpretation
- **Per-issue-type created→resolved actuals (n, avg, max): DYNAMIC** —
  fetchable live via the JQL in the table above; prefer a fresh fetch over
  any stored copy whenever Jira is reachable. A profile MAY keep a dated
  snapshot of the numbers as the offline fallback, but it is the fallback,
  cited with its date.
- **What dominates the tail: STORED** — the interpretation ("Task tail
  driven by waits on other teams", "wait-bound on review, not
  effort") is mined judgment the JQL cannot give you; each claim traceable
  to tickets you read.
- These feed the estimate priors AND the two-number (human-baseline /
  AI-assisted) rule in
  [HOW-PROFILES-FEED-ESTIMATES.md](HOW-PROFILES-FEED-ESTIMATES.md) §4/§4a:
  wait-bound tails survive AI assistance; effort-bound work does not.

### 6. Decision-making / escalation — STORED
Who signs off on what (deploys, security, scope — as roles); the observed
escalation path for cross-team blockers (which channel *function*, what
format, who routes it); any formal gates (CI gates, release trains,
feature-flag conventions). This section also names the team's **preferred
sign-off channel/format** — what clerk's PENDING-EXTERNAL flow uses to
draft cross-team sign-off requests.

### 7. Out of scope (guardrail footer — verbatim, STORED)
> No judgments about individual performance, speed, or culture quality.
> Roles above are observed functions only. No rosters, timezones, service
> lists, or channel IDs — those are DYNAMIC and fetched at use-time.

## Optional sections (STORED)
- **Release cadence** (if the team ships on trains/RCs — affects rollout timing).
- **Known SLAs** (only if explicitly stated by the team, with the source).

## Minimum viable profile
Header (with team slug) + Identity's STORED keys + one dated
response-pattern observation + whatever Jira conventions one mining pass
yields. Everything else can be added incrementally: combined with the
DYNAMIC fetches (roster, timezones, channel) an MVP profile is already
enough to correct timezone-latency assumptions in estimates.
