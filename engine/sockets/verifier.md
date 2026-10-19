# Socket: verifier

## Purpose
PR-time verification: run the test suites **and** capture end-to-end evidence
artifacts proving the change does what the ticket asked. The contract's core
rule: **unit tests passing is not sufficient evidence.** A verification run
must include at least one artifact produced by exercising the changed behavior
for real — driving the affected flow, an integration/e2e run, a screenshot, a
recorded request/response, captured log output from the real code path.

This is deliberately lightweight compared to the `deploy-harness` socket: the
verifier runs per-PR in a local/CI context. It never deploys to a real
environment — that is [deploy-harness](deploy-harness.md), which has its own
strict trigger rules.

## Consumed by
**PR** (stage 8), before the PR is marked ready. Re-run when the standing
bot-comment loop pushes new commits.

## Invocation
A command declared in `stack.yaml` under `sockets.verifier`. One JSON request
on stdin, one JSON response on stdout.

Exit codes: `0` verification PASSED with sufficient evidence · `1` verification
FAILED or evidence insufficient (details in the response) · `2` contract
violation.

## Request schema
```json
{
  "repo_path": "string — absolute path to the working checkout",
  "diff_ref": "string — git range being verified",
  "ticket_id": "string — canonical ticket id",
  "claims": "array of strings — the behavior claims the change is supposed to make true"
}
```

## Response schema
```json
{
  "verdict": "pass | fail",
  "test_results": {"command": "string", "passed": "integer", "failed": "integer"},
  "evidence": [
    {
      "claim": "string — which claim this supports",
      "kind": "e2e-run | integration | screenshot | log-capture | request-trace",
      "artifact": "string — path or URL of the stored artifact",
      "note": "string — what the artifact shows"
    }
  ],
  "next_step": "string — hint for the calling agent"
}
```

A `pass` verdict with an empty `evidence` array is invalid — the engine treats
it as exit-2 misbehavior by the provider. Every claim in the request must be
matched by at least one evidence entry, or the verdict must be `fail`.

## Example exchange
Request:
```json
{
  "repo_path": "/work/deliveries",
  "diff_ref": "main...HEAD",
  "ticket_id": "acmeco/deliveries#482",
  "claims": ["Endpoints returning Retry-After: 0 are redelivered after the minimum backoff, not immediately"]
}
```
Response (exit 0):
```json
{
  "verdict": "pass",
  "test_results": {"command": "acme-test deliveries --all", "passed": 214, "failed": 0},
  "evidence": [
    {
      "claim": "Endpoints returning Retry-After: 0 are redelivered after the minimum backoff, not immediately",
      "kind": "e2e-run",
      "artifact": "/work/deliveries/.verify/482-retry-after-zero-run.json",
      "note": "Registered an endpoint returning Retry-After: 0 via the local API, observed redelivery at 1000 ms matching the configured minimum backoff; full request/response captured"
    }
  ],
  "next_step": "attach the evidence artifact paths to the PR description, then mark the PR ready"
}
```
