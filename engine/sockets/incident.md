# Socket: incident

## Purpose
Post-merge investigation hook. When a merged change is suspected of causing
trouble (alert, error spike, user report), the engine calls this socket to ask
the company's observability/incident tooling: *what does the environment say
about this change?* The socket returns findings; it never mutates anything —
mitigation is a human decision.

## Consumed by
**Post-merge** (outside the per-change pipeline). Typically triggered by a
human ("did my merge break this?") or by a company-side alert integration.

## Invocation
A command declared in `stack.yaml` under `sockets.incident`. One JSON request
on stdin, one JSON response on stdout. Investigations can be slow; the engine
applies the timeout configured in `stack.yaml` rather than a socket default.

Exit codes: `0` investigation completed (including "found nothing") ·
`1` provider failure · `2` contract violation.

## Request schema
```json
{
  "merge_ref": "string — merged commit SHA or PR reference under suspicion",
  "symptom": "string — what is being observed, in plain language",
  "window": "optional string — time window to inspect, e.g. \"2h\"",
  "environment": "optional string — which environment, e.g. \"staging\" | \"prod\""
}
```

## Response schema
```json
{
  "verdict": "implicated | exonerated | inconclusive",
  "findings": [
    {
      "summary": "string — one observation",
      "evidence": "string — log excerpt, metric, or link that supports it",
      "confidence": "number 0..1"
    }
  ],
  "suggested_actions": "array of strings — options for the human; the socket never executes them",
  "next_step": "string — hint for the calling agent"
}
```

## Example exchange
Request:
```json
{
  "merge_ref": "acmeco/deliveries#517",
  "symptom": "deliveries-svc 5xx rate tripled since 14:00",
  "window": "3h",
  "environment": "prod"
}
```
Response (exit 0):
```json
{
  "verdict": "implicated",
  "findings": [
    {
      "summary": "5xx spike starts 4 minutes after the deploy containing #517",
      "evidence": "deploy marker 14:02, first 5xx burst 14:06; error signature 'BackoffRangeError' introduced in src/deliveries/backoff.ts",
      "confidence": 0.85
    }
  ],
  "suggested_actions": ["roll back the 14:02 deploy", "feature-flag off zero Retry-After path"],
  "next_step": "present verdict and suggested_actions to the human; do not execute any mitigation automatically"
}
```
