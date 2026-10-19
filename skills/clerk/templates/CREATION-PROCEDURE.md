# Ticket Creation Procedure (clerk)

Exact MCP call sequence for creating Jira tickets, with human-approval gates and error handling. Tool names are the Atlassian remote MCP (`mcp__claude_ai_Atlassian__*`, or the equivalent server your session exposes). The site is resolved fresh via `getAccessibleAtlassianResources` (for example `example.atlassian.net`); never hardcode a cloudId in shipped code.

Ticket content is drafted per [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md) before this procedure starts. Project specifics (issue type ids, required fields, estimate field, priority names, title prefixes, link types) come from the project's Jira profile, never from this file. Payloads below use placeholders such as `<task id>` and `<estimate field>` that the profile fills in; see [jira-project-profile.example.yaml](jira-project-profile.example.yaml) for the shape.

**Cardinal rules**
1. NOTHING is written to Jira without an explicit human approval of the full preview (print every epic/ticket, wait for confirm).
2. All preflight is read-only and cheap. Always do it; never draft against assumed metadata.
3. There is NO delete tool in this MCP. A wrong create is permanent until a human decides; recovery is editJiraIssue + transition to a won't-do status with an explanatory comment, which itself needs approval.
4. Errors are raised loudly with the failing field named. Never silently drop a field to make a create succeed.

## Phase 0 — Resolve site & identity (read-only)
```
getAccessibleAtlassianResources {}            -> cloudId
atlassianUserInfo {}                          -> reporter identity (sanity)
lookupJiraAccountId { cloudId, searchString: "<assignee name or email>" }
                                              -> accountId for assignment
```

## Phase 1 — Project profile (read-only, per target project)

The profile is a local YAML file at `.local/jira-projects/<KEY>.yaml` (gitignored; the detent clone's `.local/` is never committed). Shape: [jira-project-profile.example.yaml](jira-project-profile.example.yaml). It holds `site`, `key`, `issue_types` (task / epic / subtask ids), `required_fields`, `estimate_field`, `priority_scheme`, `title_conventions`, and `link_types`.

**1a. Profile exists** — load it. If `profile_date` is older than 90 days, or any create in this run fails on a field the profile did not predict, treat it as stale and rebuild it through 1b.

**1b. Profile missing or stale** — build it from the metadata API, then confirm before saving:
```
getVisibleJiraProjects { cloudId, action: "create", searchString: "<KEY>" }
   -> confirms create permission + project id
getJiraProjectIssueTypesMetadata { cloudId, projectIdOrKey: "<KEY>" }
   -> issue type NAMES + IDs + hierarchy. Note whether a Story type exists;
      if not, map story-shaped work to Task. Some projects name their types
      after routing categories; there, type choice IS routing.
getJiraIssueTypeMetaWithFields { cloudId, projectIdOrKey, issueTypeId,
                                 requiredFieldsOnly: false }
   -> run for EVERY type you will create. Harvest:
      required fields (and whether each has a default),
      the estimation field + allowed option IDs (never assume story points),
      enum fields worth setting (category, region, acceptance-testing flag),
      the priority names exactly as returned, and the default.
getIssueLinkTypes { cloudId }
   -> exact link type names and their inward/outward wording.
```
`title_conventions` cannot be read from metadata. Fill it from a fields-limited JQL over the project's recent tickets (`project = <KEY> AND created >= -90d`, fields `key, summary, issuetype`), recording only prefixes that appear repeatedly. If none do, leave the list empty.

Show the assembled profile to the user and ask them to confirm or correct it. Save it only after the confirmation. A profile that was never confirmed is not used for a create.

**1c. Generic gotchas (true on any Jira project; keep them regardless of the profile):**
- Subtasks take `parent` as a top-level `createJiraIssue` argument, not inside `additional_fields`. It is required.
- Task-only custom fields (Exit Criteria, estimate, category) usually do not exist on the subtask screen and return 400 if sent.
- Option-select fields take `{"id": ...}` (robust) or `{"value": ...}`; multicheckboxes take an ARRAY of those; cascading selects take `{"id": parent, "child": {"id": child}}`; textarea customs accept a plain string with `contentFormat: "markdown"`.
- Priority names are matched exactly as the metadata returns them. A project with a P0..P4 scale takes `{"name": "P2"}`, not `Highest`.
- Link direction: "A is blocked by B" means `inwardIssue` = B (the blocker), `outwardIssue` = A (the blocked one). This is the top cause of wrong links.
- Team-managed projects link an epic to its children through the `parent` field; company-managed projects may need the Epic Link field. The profile's `project_style` says which.

## Phase 2 — Duplicate & precedent check (read-only)
```
searchJiraIssuesUsingJql { cloudId,
  jql: "project = <KEY> AND (summary ~ \"<terms>\" OR text ~ \"<terms>\")
        AND created >= -365d ORDER BY updated DESC", maxResults: 20 }
```
- Hit that IS the same ask -> stop; propose commenting on the existing issue instead (atlassian:triage-issue territory).
- Hits that are prior art -> cite in the ticket's **Precedent** section (key + one-line outcome). This search is mandatory: precedent is a differentiator, not garnish.

## Phase 3 — Draft + APPROVAL GATE 1 (no writes yet)
Render every ticket per [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md) into a preview: hierarchy tree (initiative -> epic -> tasks -> subtasks), per-ticket type/fields/links table, and the exact field payloads. Human must reply approve (or edit) before Phase 4. If the plan includes >10 tickets, also show the count summary table first.

## Phase 4 — Create (order matters: parents before children)

### 4a. Epic
```
createJiraIssue {
  cloudId, projectKey: "<KEY>", issueTypeName: "Epic",
  summary: "<Program name> — <scope>",
  contentFormat: "markdown", description: "<epic body per template>",
  additional_fields: {
    "labels": ["<program label>"],
    "parent": { "key": "<initiative key>" }     // roll-up layer, only if the profile has planning_parent; see gate below
  }
}
```
**Initiative gate:** setting the epic's parent to an initiative places it in the quarterly investment plan, which is a planning commitment. It needs a named human sign-off (team lead) separate from Gate 1. If not granted, create the epic parentless and record the follow-up.

### 4b. Task under the epic
```
createJiraIssue {
  cloudId, projectKey: "<KEY>", issueTypeName: "Task",
  summary: "<prefix from profile> <what> — <component>",
  contentFormat: "markdown", description: "<task body per template>",
  assignee_account_id: "<from lookupJiraAccountId>",   // only if human named an assignee
  additional_fields: {
    "parent": { "key": "<epic key>" },
    "priority": { "name": "<name from profile priority_scheme>" },
    "labels": ["<label>"],
    "<each required field from profile>": "<value in the shape the profile records>",
    "<estimate field>": { "id": "<option id from profile>" },   // set by id, never leave the placeholder default
    "<optional category / region fields>": { "value": "<allowed value>" }
  }
}
```
Field-shape rules are in 1c.

### 4c. Subtask
```
createJiraIssue {
  cloudId, projectKey: "<KEY>", issueTypeName: "Subtask",
  parent: "<task key>",                        // top-level param for subtasks, REQUIRED
  summary: "<one verifiable action>",
  contentFormat: "markdown",
  description: "## What\n...\n## Steps\n...\n## Done when\n* [ ] ..."
}
```
Do not pass Task-only customs on subtasks; see 1c.

### 4d. Links (after both endpoints exist)
```
createIssueLink { cloudId, type: "<link name from profile link_types>",
  inwardIssue: "<KEY-blocker>",      // the one that BLOCKS
  outwardIssue: "<KEY-blocked>" }    // the one that IS BLOCKED
```
Direction check as in 1c. Also mirror every link in the description's Dependencies section (prose + link, per template). Only hard external blockers get the ticket transitioned to Blocked; soft deps stay documented-only.

### 4e. Status transitions (optional, e.g. straight to Ready for Development)
```
getTransitionsForJiraIssue { cloudId, issueIdOrKey } -> valid transition ids
transitionJiraIssue { cloudId, issueIdOrKey, transition: { id } }
```
Never guess transition IDs; they differ per project workflow. Leave a new ticket in the project's default entry state (often a triage state) unless the human said otherwise.

### 4f. Epic manifest back-fill
After all children exist, append the ticket-manifest table (Task | Key | State | estimate) to the epic:
```
editJiraIssue { cloudId, issueIdOrKey: "<epic key>", contentFormat: "markdown",
  fields: { "description": "<original body>\n\n---\n## Tickets created\n| Task | Key | State | Estimate |\n..." } }
```
(editJiraIssue replaces the whole field. Always re-fetch the current description first with getJiraIssue and append, never overwrite blind.)

## Approval gates summary
| Gate | Before | Who approves |
|---|---|---|
| 0. Profile confirmation | saving a newly built project profile | requesting human |
| 1. Plan preview | any createJiraIssue | requesting human, full-text preview |
| 2. Initiative parenting | epic parent -> initiative | team lead / planning owner |
| 3. Assignment | assignee_account_id set | the human (never auto-assign others) |
| 4. Transitions & Blocked | transitionJiraIssue | human, per ticket |
| 5. Any edit/recovery of an existing issue | editJiraIssue on issues clerk didn't just create | human |

## Error handling
- **Create 400 "field X is required"** — re-run getJiraIssueTypeMetaWithFields for that type (screens drift), mark the profile stale, surface the missing field to the human with allowed values, retry once with the corrected payload. Never fabricate a value to pass validation.
- **Create 400 "Field 'customfield_X' cannot be set"** — the field is not on that type's create screen (e.g. the estimate field on a subtask). Drop it ONLY with an explicit note in the run report; if it was load-bearing (a required field), stop and ask.
- **Priority rejected** — use the names from the profile's `priority_scheme` exactly, e.g. `{"name": "P2"}`. If the profile is stale, re-read the names from the metadata.
- **Parent/epic link rejected** — hierarchy violation (subtask under epic, task under task) or cross-project parenting; re-check hierarchyLevel from the profile and re-plan. Do not fall back to a Relates link silently.
- **createIssueLink failure** — verify both keys exist (a failed earlier create may have been skipped) and the type name matches getIssueLinkTypes exactly; retry once, then raise with the pair listed.
- **Partial-batch failure** — stop the batch at first hard failure; report created-so-far keys + not-created list; ask before resuming. Never leave the human guessing which half of a plan exists.
- **Wrong ticket created** — no delete exists. Propose (Gate 5): editJiraIssue to correct, or transition to a won't-do status + addCommentToJiraIssue explaining; execute only on approval.
- **Rate limits / 5xx** — retry once with a logged warning, then raise the last error (no infinite retries, no silent fallback).
- **MCP result >token limit** (searches on big projects) — results spill to a file; parse with jq against the saved path rather than re-querying with smaller pages first.

## Post-create verification (closes the loop)
```
getJiraIssue { cloudId, issueIdOrKey: "<new key>", fields: ["summary","parent","priority","labels","<required fields>","<estimate field>","issuelinks","status"] }
```
Diff against the approved plan for EVERY created issue; report `key -> URL -> field-diff (should be empty)` as the run's evidence. A create that can't be re-read and matched is not done.
