# Ticket Template (clerk)

End-to-end template for turning any-shape requirements into researched, approach-approved Jira tickets. Project specifics (issue type ids, required fields, estimate unit, priority names, title prefixes, link types) are NOT hardcoded here: they come from the target project's Jira profile (see [CREATION-PROCEDURE.md](CREATION-PROCEDURE.md) Phase 1 and [jira-project-profile.example.yaml](jira-project-profile.example.yaml)). Examples below use the fictional AcmeCo webhook-delivery service and project `PROJ`.

**Prime directive:** a good ticket is one an engineer can pick up and start without re-asking anyone anything, and that survives triage on the first pass. Weak tickets stall in the project's triage and clarification states, and triage bots tag them as awaiting clarification.

---

## 1. Universal skeleton

Every ticket description follows this order. Sections marked (req) must never be omitted; others are omitted only when genuinely N/A. Say `N/A — <reason>` rather than deleting silently for epics and stories.

```markdown
## Problem statement (req)
One paragraph: what is happening, why it is a problem, what should happen
instead, and the impact if not addressed (customer harm, support
load, losses, trust). No solution language here.

## Context & links (req)
- Team: <owning team name, as the project's profile spells it>
- Epic / parent: <PROJ-123 link>
- PRD: <Confluence link>          - API/design review: <Confluence link>
- Evidence: <Slack permalinks, dashboards, log queries, spreadsheets>
  (Slack evidence MUST be a permalink + who said it + date —
   e.g. "Support confirmed (Sam, 2026-07-01): three customers saw duplicate events. <permalink>")
- Change type if applicable: <new capability / config-only / migration / bugfix>

## Chosen approach — and why (req for anything non-trivial)
The selected approach in 2-6 sentences, then:
**Precedent:** cite the prior art that de-risks it: earlier tickets that did
the same shape of work (key + one-line outcome), existing code paths
("the RetryScheduler already handles X for webhook.delivered events"), or a past
incident review. A ticket with no precedent claim must say "no precedent found —
first of its kind" explicitly.

## Alternatives considered
For each rejected option: name, one-line description, why rejected
(cost, risk, precedent against, team constraint). 1-3 rows is enough.

## Scope (req)
**Repo scope: <exactly one repo>** (req on every implementation ticket) —
the single repo whose changes this ticket delivers. Work touching N repos
is N tickets (one per repo, ordered with Blocked-by/Blocks links,
provider/contract repo first) plus a dedicated integration-verification
ticket for the cross-repo evidence — that one states
`Repo scope: integration-verification (evidence only, no code scope)`.
A ticket scoped to two repos is a forbidden failure mode: split it.
**In scope:** bullet list.
**Out of scope:** bullet list. Name the adjacent things people WILL assume
are included. This is where scope creep dies.

## Steps
Numbered implementation plan. Each step should name the concrete artifact
touched (file, service, config, repo). This is the section engineers execute.

## Acceptance criteria (req)
Checkbox list. Rules:
- Outcome-based and testable, not implementation steps.
- Each maps to something observable (a response field, a delivered event,
  a firing alert, a passing suite).
- ALWAYS end with the runnable gate, e.g.:
  * [ ] <the repo's full check command> passes: tests, lint, formatter, and the coverage gate the repo's CI enforces

## Verification / test plan
How AC will be exercised: unit / staging E2E / stakeholder UAT / shadow-parity.
Name the environment and the driving action ("suppress the ack in staging
and confirm the retry fallback fires"). If staging acceptance testing is
needed, set the project's field for it (profile `optional_fields`).

## Dependencies & involved teams (req if any exist)
- Blocked by: <KEY> — <why> (also create the real Jira link, not just prose)
- Blocks: <KEY>
- Involved teams: <team — what you need from them, e.g. "platform-config
  owners: seed the new signing-key entries">
Soft dependencies are DOCUMENTED here, not encoded as Blocked status.
Only hard external blockers justify Blocked state.

## Estimate & basis (req)
The estimate in the project's OWN unit (profile `estimate_field`: a t-shirt
Level of Effort, an effort note, or story points if the field exists) plus
one line of basis: "S (1-3 days) — same shape as PROJ-123, which took 2 days"
or "M — new surface, no precedent". Never a bare number.
**Two numbers (req):** human-baseline AND AI-assisted, each with basis —
"Human-baseline: S (2-3 days, team Task cycle-time avg 4d). AI-assisted:
~1 day build; elapsed still gated by review + another team's sign-off
(wait-bound, unchanged)." Rules and calibration evidence (the A/B eval's 5-10x
single-number overshoot) in
[HOW-PROFILES-FEED-ESTIMATES.md](HOW-PROFILES-FEED-ESTIMATES.md) §4a.
A single-number estimate is a rejected draft.
**Effort class (req):** the small / medium / large+ class assigned during
research, recorded here verbatim (e.g. "Effort class: medium"). It rides
along with the project-unit estimate because it drives model routing when
sub-work is dispatched (small/medium → latest Opus; greater-than-medium →
latest Fable; enforced, see the SKILL's hard invariants).

## Rollout / feature flags
Flag name + owner, how it is switched on (all at once or per endpoint), rollback
trigger and mechanism ("flag off, previous behavior resumes"). Config-only changes:
state the deploy/verify order. If truly N/A (docs), say so.

## Monitoring / alerts
What proves it is healthy in prod: dashboards, alert rules touched or added,
the metric that would regress. For delivery work: retry-exhaustion and
DLQ-depth alert rules affected.

## Definition of done (req)
The project's DoD. If the profile lists a required Exit Criteria style field,
populate it rather than repeating it in the description. A typical set:
1. Merged
2. Deployed to staging and verified in staging
3. Deployed to prod and verified in prod
4. [if applicable] fixtures run in both environments
Add ticket-specific exits on top (e.g. "typo'd alert rule confirmed firing in
prod").
```

### Title grammar

`[prefix] <what> — <component>` where the prefix set comes from the profile's `title_conventions.prefixes`. A typical set:
- `[feature]` — the main build task of an epic
- `[infra]` — config, enablement, or infrastructure change in an existing service
- `[fix]` — correction found in verification/testing
- `[blocked]` — work waiting on another team or on missing information
- `[spike]` — time-boxed investigation that ends in a written answer
- `[Phase N]` / `[Scale gate]` / `[Docs]` for phased programs

If the profile has no prefixes, do not invent any. Mirror what the project's recent tickets actually use.

Bug titles: `<Component>: <symptom> — <specific wrong behavior>` (good: "Batch delivery: receivers reject batched requests — X-Signature header sent empty"; bad: "Signing bug").

### Anti-patterns (each is common in practice, with its consequence)

| Anti-pattern | Example | Consequence |
|---|---|---|
| Vague 2-word title | "Signing bug" | Stalled, tagged awaiting-clarification by the triage bot |
| Screenshots as load-bearing spec (blob URLs don't render) | A pasted screenshot of the failing request | Assignee can't see the requirement |
| No acceptance criteria | A description that ends after the problem statement | Sits in triage |
| Scope added mid-description | "I am adding the retry dashboard to the scope because..." | Untracked scope creep |
| Dependency as cc-mention or prose only | "cc @platform-config, needs their schema change first" | Not visible on boards; nothing blocks |
| Blocked status for soft internal deps | A ticket parked in Blocked while the other team's change is only a nice-to-have | Board noise; document the dependency, don't block |

---

## 2. Per-issue-type guidance

**Preflight rule that overrides everything below:** issue types and fields differ per project. One project may have no Story type; another may name its types after routing categories ("Task: Config Change"); another may have Story. Load the project's profile (or build it from `getJiraProjectIssueTypesMetadata` + `getJiraIssueTypeMetaWithFields`) before drafting; see [CREATION-PROCEDURE.md](CREATION-PROCEDURE.md). Issue type ids below are placeholders; read the real ones from `issue_types` in the profile.

### Epic (profile `issue_types.epic`, hierarchyLevel 1)
An epic is a program container: a body of related work with one objective. Required content:
- **Objective** — one sentence ("Ship signing v2 with key rotation for all webhook deliveries").
- **Context** — the business driver, stakeholder confirmations with names and dates, external constraints.
- **Reference docs** — PRD + API review Confluence links, upstream API spec links, coverage tables (e.g. which event types each endpoint version supports).
- **Pending from other teams / open unknowns** — explicit list.
- **Scope in/out** — including *named* excluded event types/features.
- **Predicted timeline** — milestones with day offsets AND per-milestone confidence (High/Medium/Low) and the adjustments applied ("-3d key-format spec already agreed; +5d testing: security review queue is historically slow"). This is the team-aware-estimation surface.
- **Ticket manifest** — once children exist, a table of Task | Key | State | LOE, appended via editJiraIssue.
- Parent: link to the planning initiative (profile `planning_parent`) when the work is quarterly-planned. That needs the separate sign-off described in the creation procedure.
- Labels: team/program labels (`signing`, `reliability`, quarter labels on initiatives).

### Story (only where the project has the type, per the profile)
Vertical slice with observable outcome. A house style that works well for program work:
- Title `[Phase N] <slice> (<plan IDs>)`.
- **State line first**: `**State — YYYY-MM-DD:** BUILT — PR #214 (draft, CI green, dark) · <one-line status> · Remaining: <x>` — kept current by edits.
- Then: Bucket (which program phase/why), Scope (bullets tied to plan IDs), No-break gate (what proves it can't regress), Effort, Depends on / Blocks, provenance footer ("Epic scoped via <agent/model>").
- In a project without a Story type, what would be a Story is a Task. Do not invent Story.

### Task (profile `issue_types.task`)
The workhorse. Full universal skeleton, plus whatever the profile's `required_fields.task` and `estimate_field` say:
- **Required custom fields** — set every one at create, even when it has an org default. Example: an Exit Criteria field with a default list of merged / staging-verified / prod-verified; set it explicitly with ticket-specific exits appended.
- **Estimate field** — set by option id, from the profile. Never leave the placeholder default (TBD) on a ticket you are calling ready. If the work is larger than the biggest option, split it.
- **Category / region / acceptance-testing fields** — optional but worth setting when the draft has the information; take allowed values from the profile. Use an "Unknown" option only as a last resort.
- **Priority** — use the profile's `priority_scheme`. A project may support both a Highest..Lowest scale and a P0..P4 scale; use the P-scale for ops-severity work and leave the default (often `Triage`) for the triage process unless the requester owns prioritization.

### Subtask (profile `issue_types.subtask`)
- **Parent is required at create** (the `parent` argument, top level). Task-only fields such as Exit Criteria, estimate, and category usually do not exist on subtasks, so keep them lean.
- One verifiable action per subtask, done in 1-2 days at most. Good pattern: `Add the key-id header to v2 payloads`, `Share the public key-set URL with the docs team`, `Verify a delivery signed with the retired key still passes during overlap`.
- Body = What / Steps / "Done when" checklist. Skip approach/alternatives; those live on the parent.

### Bug (profile `issue_types.bug`)
Universal skeleton with Problem statement expanded into: **Steps to reproduce** (numbered) / **Expected** / **Actual** / **Error** (verbatim message + stack head + Slack/error-tracker permalink) / **Notes** (what's unknown). Link the causing ticket with the profile's `defect` link type where known. Never paste screenshots as the only evidence.

### Blocked-work ticket (a Task, titled `[blocked]` where the project uses that prefix)
For external unknowns that gate work:
- **Blocker** — what exactly cannot proceed, with the checked evidence (endpoint checked, empty response).
- **Scope** — what it blocks and, critically, what it does NOT block.
- **Classification** — blocked on another team (their deliverable is not there yet) or blocked on missing information (an answer or spec nobody has written down). Severity: **hard** (stops the epic) vs **soft** (stops one capability), expected response time.
- **Owner** — team/person who can answer; TBD allowed but with a next step to identify.
- **Stage tracking** — checkbox pipeline (owner identified → answered → unblocked work resumed).
- Status: only hard open blockers put dependent tickets into Blocked.

---

## 3. Worked example (fictional)

> **Title:** `[primary] Add HMAC-SHA256 signing v2 with key rotation — webhook-dispatcher`
> **Type:** Task · **Parent:** PROJ-123 (Signing v2 epic) · **Priority:** Triage · **LOE:** M (4-7 days) · **Delivery Category:** Signing · **Staging Acceptance Required?:** Yes
>
> **Problem statement** — Webhook payloads are signed with one long-lived HMAC-SHA1 secret per endpoint. A leaked or expiring secret cannot be replaced without a coordinated outage, because the receiving side has to switch the moment we do. Two enterprise customers have held their security approval on this, and every other customer carries the same exposure.
>
> **Context & links** — Service: webhook-dispatcher · Change type: new capability · Epic PROJ-123 · Design doc <confluence> · Security review <confluence>.
>
> **Chosen approach** — Emit an `X-Signature-V2` header next to the existing one, carrying a key id, and store two active secrets per endpoint (current and next) so a rotation has an overlap window. **Precedent:** PROJ-110 added the versioned-header scheme for payload schema v2 (closed Done in 3 days) and PROJ-111 built the overlap handling the key store already uses for certificate renewals.
>
> **Alternatives considered** — (a) Replace v1 in place: rejected, it breaks every receiver on the same day. (b) JWT-signed payloads: rejected, receivers verify with plain HMAC libraries today and the design doc rules out new receiver-side dependencies.
>
> **Scope** — In: v2 signer, key-id header, two-secret storage, rotation call, docs page. Out: receiver-side verification samples (PROJ-124), removing v1 (separate ticket after the deprecation window), self-service rotation UI (PROJ-125).
>
> **Steps** — 1. Add the v2 signer next to the v1 signer; emit `X-Signature-V2` with the key id. 2. Extend the key store to hold current and next secrets per endpoint. 3. Add the rotation call: promote next to current and keep the retired secret valid for 24 hours. 4. Gate it with a per-endpoint `signing_v2` flag. 5. Publish the docs page.
>
> **Acceptance criteria** — [ ] a staging delivery to an opted-in endpoint carries both `X-Signature` and `X-Signature-V2` · [ ] after a rotation, payloads signed with the new secret verify, and payloads signed with the retired secret verify until the 24-hour overlap ends · [ ] a rotation with no next secret is rejected with a clear error · [ ] the repo's full check command (tests, lint, format) passes in CI.
>
> **Verification/test plan** — staging E2E: rotate while deliveries are in flight and confirm zero signature failures at a test receiver; cite staging delivery IDs in comments rather than screenshots.
>
> **Dependencies & involved teams** — Blocked by PROJ-126 (key-store schema migration) [real Jira link]. Involved: Platform Config (key-store schema review), Security (sign-off on the HMAC parameters).
>
> **Estimate & basis** — Human-baseline: M (4-7 days), PROJ-110 actuals scaled up for secret storage. AI-assisted: ~2 days build; elapsed still review-bound and gated on the security sign-off.
>
> **Rollout/flags** — `signing_v2`, per endpoint, off by default, owned by the delivery team. Rollback is flag off for that endpoint; the v1 header is sent throughout, so nothing depends on v2.
>
> **Monitoring/alerts** — signature-failure rate per endpoint; confirm a signature-failure alert exists before the first endpoint is enabled (else file the project's alerting task, see PROJ-112 for the shape).
>
> **Exit Criteria (field)** — org default 4 items + "first enabled endpoint ran 7 days with a signature-failure rate at the v1 baseline".

---

## 4. Per-project conventions come from the profile

Do not carry conventions from one project to another. Each project's profile (`.local/jira-projects/<KEY>.yaml`) records its own. The table shows the kinds of difference a profile exists to capture, using fictional projects:

| Project | Types | Estimation | Description style | Notes |
|---|---|---|---|---|
| PROJ (team-managed) | Task/Epic/Subtask/Bug, no Story | LOE t-shirt custom field | Universal skeleton; Exit Criteria field required | Prefix grammar; triage statuses include a clarification-needed state; epics parent to initiatives |
| OPS (team-managed) | Category-named types ("Task: Config Change", "Task: Alerts & Dashboards", "Task: Other") | P-scale priority, no LOE | Intake form: What is happening / Why it's a problem / What should happen instead / Who is affected, then Current config, Requested config, Exit Criteria; written for non-technical requesters | Choosing the right TYPE is the routing decision; bot-managed labels are not set by hand |
| PLATFORM (company-managed) | Has Story | Effort noted in body | `[Phase N]` titles, dated State line, No-break gate, Depends/Blocks, provenance footer | Stories tie to plan IDs |
| PLAN | Initiative (hierarchyLevel 2) | none | Minimal; labels carry the quarter | The roll-up layer; epics point here via parent |
