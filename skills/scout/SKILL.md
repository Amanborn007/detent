---
name: scout
description: >-
  The shared research layer — {query, repo?, domain?, depth} in, one ranked,
  attributed brief out; fans out to the knowledge providers configured in the
  pack (`knowledge.providers`), repo docs, and notes on neighboring services
  (callers and callees) when the pack enables them, degrading gracefully when a provider is unreachable
  and caching per run. Trigger whenever the engine research stage, clerk
  research, or the user needs org context about a service, domain, or change
  before planning, reviewing, or debugging.
---

# scout

Answer one question well: **"What does this organization already know that is
relevant to this change?"** — one query in, one ranked, attributed brief out.
This is the single shared research implementation; nothing else in the stack
talks to the knowledge providers directly.

## Evidence

Read [`docs/evidence-and-voice.md`](../../docs/evidence-and-voice.md) before writing a
brief. Scout is the skill it matters most for: **every finding carries how it was obtained** — read
it, ran it, documented, reported, or inferred — and an inferred finding never sits with the verified
ones. Report which providers were searched AND which were not, because coverage is the thing a
caller cannot judge from findings alone. A provider that failed to run is never reported as a
provider that found nothing.

## Contract

```
query:  what the caller wants to know (free text)                — REQUIRED
repo:   target repository (e.g. acmeco/webhook-dispatcher)       — optional
domain: business/technical domain hint (e.g. "delivery")         — optional
depth:  quick | standard | deep                                  — default: standard
```

- `repo` absent → run org-level research only (no `local` providers, no blast
  radius) and say so in the brief. Do not guess a repo.
- `domain` absent and `repo` present → infer it from the repo README.
- `depth` semantics:
  - **quick** — `local` providers plus one query to the first reachable `mcp`
    provider. No blast radius. For "orient me fast".
  - **standard** — every configured provider, one query each per angle, blast
    radius if the pack enables it.
  - **deep** — standard plus follow-up queries on the top findings and full
    1-hop neighbor sweep. For high-risk or cross-service changes.

## Consumers (this layer is shared — do not fork it)

Both research flows call this skill with the same contract instead of
implementing their own fan-out:

- **clerk research** — the mandatory precedent-hunting step of the
  clerk skill (GitHub/Jira/Confluence precedent work stays in
  clerk; org/service knowledge comes from here).
- **engine research stage** — `engine/stages/research/SKILL.md`, whose
  knowledge fan-out (step 3, via the `sockets.knowledge` providers in
  `stack.yaml`) is served by this skill when the pack configures providers.

If you are about to write provider-querying logic anywhere else in the stack:
stop, call this instead, and extend this file if something is missing.

## Procedure

### 0. Load the pack, then check the cache

**Pack.** Read `pack.path` from `detent.user.yaml`; if unset, use
`packs/example/stack.yaml`. Run `engine pack validate` first and stop on a
non-zero exit, reporting its `errors`. Take `knowledge` and `network` from it. A pack file
that is missing, unparseable, or lacks a `knowledge.providers` list is an
error: stop and report the path and what is wrong. Never fall back to default
providers.

`knowledge.providers` present but empty → say `Knowledge: OFF (no providers
configured in <pack path>)` and stop. No brief is built from nothing.

**Cache** (inside an engine run). If a `.sdlc/<run-id>/` directory is in play,
the cache lives at `.sdlc/<run-id>/knowledge-cache/`. Key:
`<query-slug>-<depth>.md` (lowercase, non-alphanumerics → `-`). On a hit,
return the cached brief with a first line `CACHE HIT: <path>` and stop —
providers are not re-queried within a run. No run context → skip caching
entirely (do not invent a cache location).

### 1. Preflight — classify and probe (never hang on a dead provider)

This is scout's instance of the engine's access preflight
([`engine/sources/PREFLIGHT.md`](../../engine/sources/PREFLIGHT.md); source
types in [`CATALOG.md`](../../engine/sources/CATALOG.md)): probe every provider
before querying, and classify each **`reachable | blocked | partial`** — the
same vocabulary the engine research stage and plan gate use. A blocked or
partial provider is never silently dropped: it is recorded in the Providers
table with its probe evidence, and it makes the brief **partial** (see Failure
handling). When scout runs inside an engine run, this per-provider
classification is what the research stage folds into `access-report.json`.

a. **Network check.** If any provider has `requires_network: private`, look at
   `network.check_cmd`. `null` → skip the check and record `network check: not
   configured` in the Providers table. Set → run it once. Exit 0 → continue.
   Non-zero → every `requires_network: private` provider is **`blocked`** for
   this run, with the command, its exit code, and its output as evidence. Say
   so loudly; do not wait and do not retry into the void.

b. **Per-provider probe**, for each entry in `knowledge.providers`:
   - `kind: local` — needs `repo`. Without it the provider is skipped and the
     Providers table says why.
   - `kind: mcp` — probe the session's tool inventory (e.g. ToolSearch for
     `server`) for the named `server` and `tool`. A server that is not
     registered or not authenticated never appears in the tool list, so a call
     is impossible: classify **`blocked`** (`blocked_reason`
     `mcp-not-registered` or `connector-unauthenticated`) and skip it with one
     warning line plus the exact probe output. "Unreachable" without evidence
     is not acceptable.
   - `required_corpus` non-null — confirm the provider exposes that corpus
     (for example by listing what it exposes). Not exposed → **`blocked`**,
     reason `corpus-missing`.

c. **Timeout rule for present providers**: budget ~60s per provider call.
   On timeout or error: retry once with a warning; still failing → classify
   the provider **`blocked`** in the provider record (with the error text) and
   continue. A provider that answers but returns a truncated/permission-limited
   result (a cap it cannot page past, redacted rows) is **`partial`**, not
   reachable — say which in the record. A slow provider never stalls the brief.

d. **Blast-radius manifest** (only if `knowledge.blast_radius.enabled` and
   `repo` given): read `knowledge.blast_radius.service_manifest` at the repo
   root (local checkout first; else `gh api repos/<repo>/contents/<manifest>`)
   and record the service name it declares. That name drives blast radius. A
   missing manifest, or one that declares no service name, turns blast radius
   OFF for this run with one line saying which; never guess a name.

### 2. Fan out (all providers the preflight left standing, in parallel where possible)

Iterate `knowledge.providers` in order; every provider that is not `blocked`
gets queried.

- **`kind: mcp` provider** — call its configured `tool` with the raw `query`;
  at standard+ depth add one scoped query (`"<system/domain> <query>"`). Collect
  docs about the services the change touches and the services that call them. When the
  provider is reachable, scout MUST **actively fetch** with fresh queries
  before writing the brief — never rely on previously loaded context, and
  never skip the fetch because the answer "seems known". A brief written
  without fresh hits while the provider was reachable is a doctrine
  violation. If the provider also indexes skills (standard+ depth), a relevant
  existing skill is a first-class result (name, owner, one line — the caller
  decides whether to invoke).
- **`kind: local` provider (only if `repo` given)** — read the listed `paths`
  (default: `README.md`, `docs/`, `CLAUDE.md`), plus top-level `*.md` and
  nested per-module `CLAUDE.md` files (`git ls-files '*CLAUDE.md' '*.md'`
  scoped to the query's area — these carry the deepest operational
  knowledge). Prefer a local checkout; fall back to `gh api`. Untracked
  local-only docs (`git status --porcelain`) are attributed `local-only,
  untracked`. Extract only query-relevant sections — never dump whole files.

### 3. Blast radius (only when the pack enables it, standard+ depth)

If `knowledge.blast_radius.enabled` is false or unset, say `Blast radius: OFF
(knowledge.blast_radius.enabled is not true in <pack path>)` once in the brief
and skip this step. Do not fill the section with guesses.

Otherwise, resolve the service's **1-hop dependency neighbors** (callers and
callees: APIs, events, shared schemas/config) from the provider named by
`neighbor_source`. If that provider is `blocked`, blast radius is blocked too:
say so in the Providers table and in the section, with the same evidence. Pull
each neighbor's gotchas and open concerns; **keep only what intersects the
change described by `query`** (same endpoint, event, schema, or config
surface). At `deep`, sweep all neighbors; at `standard`, the obviously
intersecting ones.

**Mechanized path**: `node engine/scout/blast-radius.mjs plan --service X
[--depth d]` and `... merge --service X --status reachable` (see
`engine/scout/test/blast-radius.test.mjs`), where X is the name read from the
manifest in step 1d. The helper never talks to a provider itself — it is a
pure plan/merge pair; the agent is the transport. Run `plan` to get the
neighbor-discovery query, execute it against the `neighbor_source` provider
(agent-side), re-run `plan` with the discovered neighbor names to get one
gotcha query per neighbor (filtered per the depth rule above), run those too,
then feed the raw results to `merge` (with the provider's `reachable | blocked |
partial` status) and paste its returned markdown section straight into the
brief. `merge` hard-refuses an unattributed gotcha or a missing provider
status — it never fabricates a source.

### 4. Merge, rank, cache, return

Rank: (1) direct hits on the target service/change, (2) intersecting
blast-radius gotchas, (3) domain knowledge, (4) relevant existing skills,
(5) background. Deduplicate across providers — same fact from two providers
= one entry, both citations. **Every item carries a source
attribution**; an unattributed claim does not go in the brief.

If step 0 found a run context, write the finished brief to
`.sdlc/<run-id>/knowledge-cache/<query-slug>-<depth>.md` before returning it.

Output format (this exact shape — consumers parse it by section):

```
## Knowledge brief: <query> (repo: <repo or "none">, depth: <depth>)

### Providers
Marks which providers were **reachable** vs **blocked/partial** this run —
`status` uses the preflight vocabulary (`reachable | blocked | partial`), and
every non-reachable row carries its probe evidence. Features the pack leaves
off get one `OFF` row, not a silent omission.
| provider | status | evidence |
| org-kb | reachable (2 queries, 7 hits) | tool search_docs present; check_cmd exit 0 |
| repo-docs | partial | gh api returned 1 of 3 nested docs; 2 permission-denied |
| blast-radius | OFF | knowledge.blast_radius.enabled is false in packs/example/stack.yaml |

### Directly relevant
- <finding> [org-kb: <doc title/id>]
- <finding> [repo-docs: docs/foo.md]

### Blast radius (1-hop neighbors of <system>)
- <neighbor>: <gotcha that intersects this change> [org-kb: <doc>]

### Existing skills that cover part of this
- <skill-name> (<owner>): <one line> [<provider id>]

### Background
- ...

### Gaps
- <what was searched but not found — say so explicitly rather than padding>
```

## Failure handling

- On a zero-hit query across all providers, append an advisory
  `detent feedback add --kind coverage-gap --area scout ...` entry
  (`engine/self-feedback/CONTRACT.md`) — the brief still returns, honestly
  reporting the gap in its own Gaps section; the journal entry is a durable
  note on top, not a substitute for saying so in the brief.
- A `blocked` or `partial` provider makes the brief **partial** — the Providers
  table says which, with the exact probe/command/error text as evidence.
  Never silently omit a provider, and never present a brief built on a blocked
  provider as if the source had been read.
- Blast radius blocked or off but repo docs name neighbors → a repo-docs-derived
  neighbor section is allowed, clearly labeled as reconstructed, never
  attributed to the provider that was down.
- **All** providers down → fail loudly; never fabricate a brief from prior
  context or memory.
- Never invent attributions.
