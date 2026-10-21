# Socket: reviewer

## Purpose
Company-specific review findings on top of the engine's own generic review:
org conventions, platform gotchas, security policy, blast-radius knowledge the
generic engine cannot have. The engine runs its own review either way; this
socket adds what only the company knows.

## Consumed by
**Review/test/docs/lint** (stage 7), on the completed diff before the PR is
opened. May be re-invoked during the standing bot-comment loop when the diff
changes materially.

## Invocation
A command declared in `stack.yaml` under `sockets.reviewer`. One JSON request
on stdin, one JSON response on stdout.

Exit codes: `0` success (zero findings is a valid, happy outcome) ·
`1` provider failure · `2` contract violation.

The built-in `claude-reviewer` runs under `DETENT_RUNTIME`: `claude-code` by
default, or `openai-compatible` with `DETENT_OPENAI_BASE_URL` and a model
(`--model` or `DETENT_OPENAI_MODEL`). A missing runtime setting exits `2`.

## Request schema
```json
{
  "repo_path": "string — absolute path to the working checkout",
  "diff_ref": "string — git range under review, e.g. \"main...HEAD\"",
  "ticket_id": "string — canonical ticket id for context"
}
```

## Response schema
Every finding carries an `action` telling the engine what to do with it, and a
`risk_level` for ordering:

```json
{
  "findings": [
    {
      "summary": "string — one-sentence statement of the issue",
      "location": "string — path:line the finding anchors to",
      "action": "no-op | auto-fix | ask-user",
      "risk_level": "low | medium | high | critical",
      "detail": "string — evidence and reasoning; for auto-fix, what the fix is"
    }
  ],
  "next_step": "string — hint for the calling agent"
}
```

Action semantics:
- **no-op** — recorded in the PR description for reviewer awareness; engine
  changes nothing.
- **auto-fix** — the engine applies the described fix, then re-runs tests and
  this socket once (no fix-loops).
- **ask-user** — the pipeline pauses and surfaces the finding to the human;
  it does not proceed on this finding without an answer.

`critical` + `ask-user` findings block the PR stage entirely.

## Example exchange
Request:
```json
{"repo_path": "/work/deliveries", "diff_ref": "main...HEAD", "ticket_id": "acmeco/deliveries#482"}
```
Response (exit 0):
```json
{
  "findings": [
    {
      "summary": "New backoff path bypasses the event-log reconciliation hook",
      "location": "src/deliveries/backoff.ts:88",
      "action": "ask-user",
      "risk_level": "high",
      "detail": "All mutations to a delivery's retry state must fire reconcile(); this branch returns early. If intentional, the owl reconciler needs a config change first."
    },
    {
      "summary": "Missing changelog entry for a subscriber-visible change",
      "location": "CHANGELOG.md:1",
      "action": "auto-fix",
      "risk_level": "low",
      "detail": "Append an Unreleased entry summarizing the Retry-After zero fix."
    }
  ],
  "next_step": "apply the auto-fix finding, then pause and surface the high/ask-user finding before opening the PR"
}
```
