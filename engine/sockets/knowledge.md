# Socket: knowledge

## Purpose
Look up context relevant to the ticket: runbooks, ADRs, wiki pages, repo docs,
past incident writeups — whatever the company has. This is the engine's only
research door.

**This socket is multi-provider by design.** `stack.yaml` declares a *list* of
knowledge providers, each an independent command implementing this same
contract. The engine fans the query out to all of them (in parallel where
possible), then merges: results are deduplicated by `source` and ranked by
`confidence` across providers, truncated to the configured `max_results`. A
single provider failing (exit 1) degrades the merge with a warning; it does
not abort research — but zero providers succeeding is a hard stage failure.

## Consumed by
**Research** (stage 2). Also available to the plan stage for follow-up queries.

## Invocation
Commands declared in `stack.yaml` under `sockets.knowledge.providers[]`. One
JSON request on stdin, one JSON response on stdout per provider.

Exit codes: `0` success — an **empty result set is still exit 0** ·
`1` provider failure · `2` contract violation.

## Request schema
```json
{
  "query": "string — natural-language or keyword query",
  "ticket_id": "optional string — canonical ticket id for provider-side context",
  "max_results": "optional integer — provider-side cap (engine merges and re-caps)"
}
```

## Response schema
```json
{
  "provider": "string — stable provider name, must match stack.yaml entry",
  "query": "string — echoed back",
  "results": [
    {
      "source": "string — where this came from (path:line, URL, doc id)",
      "excerpt": "string — the relevant snippet, <= ~240 chars",
      "confidence": "number 0..1 — provider's own relevance estimate"
    }
  ],
  "next_step": "string — hint for the calling agent"
}
```

## Example exchange
Request (engine sends the same to every configured provider):
```json
{"query": "retry backoff zero Retry-After", "ticket_id": "acmeco/deliveries#482"}
```
Response from the `runbooks` provider (exit 0):
```json
{
  "provider": "runbooks",
  "query": "retry backoff zero Retry-After",
  "results": [
    {"source": "runbooks/delivery/retry-backoff.md:44", "excerpt": "A Retry-After of 0 must never pass through the exponential backoff path...", "confidence": 0.92}
  ],
  "next_step": "read the highest-confidence sources in full before relying on excerpts"
}
```
The engine merges this with the responses from `adr-index` and `repo-docs`,
dedupes by `source`, sorts by `confidence`, and hands the top slice to the
plan stage.

## Reference adapter
[`adapters/repo-docs-knowledge`](../adapters/repo-docs-knowledge) — greps a
checked-out repo's README/docs/ tree. Intended as one provider among several.
