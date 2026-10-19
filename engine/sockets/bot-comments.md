# Socket: bot-comments

## Purpose
Watch an open PR's comments and hand the engine a classified snapshot: who
wrote each comment (**bot vs human**) and whether it needs action
(**actionable vs informational**). This powers the standing loop that keeps a
PR moving until merge — CI bots, lint bots, security scanners, and human
reviewers all land in one normalized stream.

## Consumed by
**Standing bot-comment loop** (stage 9). The engine polls this socket on the
interval configured in `stack.yaml`, diffs against the previous snapshot, and
triages new actionable comments (reply / code change / escalate to the human).

## Invocation
A command declared in `stack.yaml` under `sockets.bot-comments`. One JSON
request on stdin, one JSON response on stdout.

Exit codes: `0` success (a PR with zero comments is a valid response) ·
`1` provider failure · `2` contract violation.

## Request schema
```json
{
  "pr": "string — canonical PR reference, e.g. \"owner/repo#123\"",
  "since": "optional ISO-8601 timestamp — only comments created after this"
}
```

## Response schema
```json
{
  "pr": "string — echoed back",
  "comments": [
    {
      "id": "string — stable comment id",
      "author": "string — login/name",
      "author_type": "bot | human",
      "classification": "actionable | informational",
      "excerpt": "string — first ~200 chars, whitespace-normalized"
    }
  ],
  "counts": {"bot": "int", "human": "int", "actionable": "int", "informational": "int"},
  "next_step": "string — hint for the calling agent"
}
```

Classification rules are the provider's business (the reference adapter uses a
simple keyword heuristic and documents it); the engine only relies on the two
enums being honest. Human + actionable comments are always escalated to the
PR author's attention, never auto-resolved silently.

## Example exchange
Request:
```json
{"pr": "acmeco/deliveries#517"}
```
Response (exit 0):
```json
{
  "pr": "acmeco/deliveries#517",
  "comments": [
    {
      "id": "issue_comment:20441",
      "author": "acme-ci[bot]",
      "author_type": "bot",
      "classification": "actionable",
      "excerpt": "coverage dropped 2.1% on src/deliveries/backoff.ts — please add tests for the new branch or apply the coverage label"
    },
    {
      "id": "review_comment:20492",
      "author": "jsmith",
      "author_type": "human",
      "classification": "informational",
      "excerpt": "Nice catch on the zero Retry-After path."
    }
  ],
  "counts": {"bot": 1, "human": 1, "actionable": 1, "informational": 1},
  "next_step": "triage the 1 actionable comment(s): decide reply / code change / escalate-to-human for each"
}
```

## Reference adapter
[`adapters/gh-bot-comments`](../adapters/gh-bot-comments) — GitHub PR issue +
review comments via `gh api`; bot detection via user type `Bot` or the
`[bot]` login suffix.
