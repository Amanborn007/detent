# Socket: ticket

## Purpose
Fetch a single work item from the company's tracker (GitHub Issues, a ticket
system, a task queue — anything) and normalize it into engine ticket JSON. The
engine never talks to a tracker directly; this socket is its only door.

## Consumed by
**Intake** (stage 1). The ticket JSON produced here anchors the intent check
(stage 4) and the recheck (stage 6).

## Invocation
A command declared in `stack.yaml` under `sockets.ticket`. The engine writes
one JSON request to stdin and reads one JSON response from stdout. stderr is
free-form logs.

Exit codes: `0` success · `1` provider failure (retried once with a warning,
then surfaced) · `2` contract violation (engine halts and asks the user).

## Request schema
```json
{
  "ticket_ref": "string — provider-native reference, e.g. \"acme-tracker:PLAT-482\" or \"owner/repo#123\"",
  "fields": "optional array of extra field names the engine wants passed through"
}
```

## Response schema
```json
{
  "id": "string — stable canonical id",
  "title": "string",
  "status": "string — open | in_progress | closed | merged (provider maps its states)",
  "body_excerpt": "string — first ~400 chars, whitespace-normalized",
  "url": "string — human-clickable link",
  "next_step": "string — hint for the calling agent"
}
```

## Example exchange
Request:
```json
{"ticket_ref": "acmeco/deliveries#482"}
```
Response (exit 0):
```json
{
  "id": "acmeco/deliveries#482",
  "title": "Retry delay drifts when endpoint returns Retry-After of 0",
  "status": "open",
  "body_excerpt": "Subscribers see redelivery delay off by up to 1 second. Repro: register an endpoint that returns Retry-After: 0...",
  "url": "https://github.com/acmeco/deliveries/issues/482",
  "next_step": "feed this ticket JSON to the research stage; fetch the full body from url if the excerpt is truncated"
}
```

## Reference adapter
[`adapters/gh-ticket`](../adapters/gh-ticket) — GitHub issues via `gh`.
