# Socket: deploy-harness

> **This is NOT the verifier.** The [verifier](verifier.md) runs per-PR,
> locally/in CI, cheap and always-on. The deploy-harness deploys a build to a
> **real environment** and tests it there — heavyweight, slow, and consuming
> shared environment capacity.

## Purpose
Deploy the change (or a custom build of it) to a real, running environment and
exercise it end-to-end there: real dependencies, real data shapes, real infra.
Produces the strongest evidence the stack can generate.

## Trigger rules — strict
The engine invokes this socket **only** when:
1. a **human explicitly asks** for a deploy-harness run, or
2. the PR is **approved and ready-to-merge**, as a final pre-merge gate
   (if the company enables that gate in `stack.yaml`).

It is **never** invoked automatically per change, per commit, or per push.
The engine treats any configuration attempting to wire it into stages 1–8 as a
`stack.yaml` validation error.

## Consumed by
On-demand (human request) or the optional approved-and-ready-to-merge gate.
Not part of the standing per-change pipeline.

## Invocation
A command declared in `stack.yaml` under `sockets.deploy-harness`. One JSON
request on stdin, one JSON response on stdout. Long-running; the engine
streams stderr through to the user as progress and applies the (long) timeout
from `stack.yaml`.

Exit codes: `0` harness ran and verdict is in the response (verdict may still
be `fail`) · `1` harness infrastructure failure (could not deploy/test at
all) · `2` contract violation — including any invocation that does not carry a
valid `trigger`.

## Request schema
```json
{
  "build_ref": "string — commit SHA or PR reference to build and deploy",
  "environment": "string — target environment name, e.g. \"staging\"",
  "trigger": "human-request | approved-ready-to-merge  (anything else is exit 2)",
  "test_sheet": "array of strings — the concrete behaviors to drive in the deployed environment"
}
```

## Response schema
```json
{
  "verdict": "pass | fail",
  "deployed": {"environment": "string", "release_id": "string"},
  "case_results": [
    {"case": "string — test_sheet entry", "result": "pass | fail", "evidence": "string — artifact path/URL"}
  ],
  "teardown": "string — what was cleaned up / what is still deployed",
  "next_step": "string — hint for the calling agent"
}
```

## Example exchange
Request (human asked "test #517 on staging"):
```json
{
  "build_ref": "acmeco/deliveries#517",
  "environment": "staging",
  "trigger": "human-request",
  "test_sheet": ["register endpoint returning Retry-After 0, redelivery waits the minimum backoff", "Retry-After 30 endpoints unchanged"]
}
```
Response (exit 0):
```json
{
  "verdict": "pass",
  "deployed": {"environment": "staging", "release_id": "deliveries-2026.07.04-r3"},
  "case_results": [
    {"case": "register endpoint returning Retry-After 0, redelivery waits the minimum backoff", "result": "pass", "evidence": "https://artifacts.acmeco.example/runs/8841/retry-after-zero.json"},
    {"case": "Retry-After 30 endpoints unchanged", "result": "pass", "evidence": "https://artifacts.acmeco.example/runs/8841/retry-after-30-regression.json"}
  ],
  "teardown": "custom build removed; staging restored to release deliveries-2026.07.01-r1",
  "next_step": "attach case_results to the PR and proceed to merge"
}
```
