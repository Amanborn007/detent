# Socket: skill-discovery

## Purpose
Given the ticket and the drafted plan outline, return the skills/plays the
company has that apply to this task (e.g. "database-migration play",
"public-API-change checklist"). Keeps the engine ignorant of what skills exist
and how they are indexed.

## Consumed by
**Plan** (stage 3), before the plan is rendered for visual review — applicable
skills become plan steps or constraints.

## Invocation
A command declared in `stack.yaml` under `sockets.skill-discovery`. One JSON
request on stdin, one JSON response on stdout.

Exit codes: `0` success (empty `skills` is valid — not every task has a play) ·
`1` provider failure · `2` contract violation.

## Request schema
```json
{
  "ticket_id": "string — canonical ticket id",
  "task_summary": "string — one-paragraph description of the intended change",
  "touched_paths": "optional array of repo-relative paths the plan expects to modify"
}
```

## Response schema
```json
{
  "skills": [
    {
      "name": "string — stable skill identifier",
      "reason": "string — why this skill applies to this task",
      "invocation": "string — how the engine/agent should invoke or load it",
      "mandatory": "boolean — true if the pipeline must not proceed without it"
    }
  ],
  "next_step": "string — hint for the calling agent"
}
```

## Example exchange
Request:
```json
{
  "ticket_id": "acmeco/deliveries#482",
  "task_summary": "Fix backoff when an endpoint returns Retry-After of 0",
  "touched_paths": ["src/deliveries/backoff.ts", "src/deliveries/retry-policy.ts"]
}
```
Response (exit 0):
```json
{
  "skills": [
    {
      "name": "backoff-timing-play",
      "reason": "touched_paths include src/deliveries/backoff.ts, which is covered by the retry-timing play",
      "invocation": "acme-skills load backoff-timing-play",
      "mandatory": true
    }
  ],
  "next_step": "load the mandatory skill(s) before finalizing the plan; cite each applied skill in the plan"
}
```
