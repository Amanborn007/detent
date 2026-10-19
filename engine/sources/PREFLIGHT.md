# Source access preflight — probe every needed source, write the access report

**Takeaway: before a stage relies on a set of sources, it probes each one with
a cheap reachability check, classifies it `reachable | blocked | partial`, and
records the result in `access-report.json`. Nothing downstream is allowed to
assume a source was readable.**

This is the runtime companion to [CATALOG.md](CATALOG.md). The catalog says
what a source type is and how reachable it should be; this file says how to
check the real state per run and how to write it down.

## Inputs and output

- **Input** — the list of sources the task needs. A source need is a pair:
  *which source type* (a CATALOG row) and *what it is needed for* (a specific
  unknown, finding, or conclusion). Research derives this list from the brief's
  unknowns and the domain; a skill derives it from the requirement.
- **Output** — `${DETENT_ROOT}/.sdlc/<run-id>/access-report.json`, written
  atomically (temp + rename). Outside an engine run (e.g. a skill invoked ad
  hoc) the report is produced inline in the skill's working notes instead; the
  schema is the same.

## The probe — cheap, never a full fetch

A probe is the **lightest** check that proves the source can be reached. It is
not the real query — it must be cheap enough to run for every source up front.
Choose the probe by the source's access method (CATALOG.md):

| Access method | Probe |
|---|---|
| **MCP connector** | Is the connector's tool present in the session's tool inventory? (e.g. search the tool list for the server's tools.) Present → optionally one trivial call (a `whoami`/1-row search) to confirm auth. Absent → cannot call it, full stop. |
| **CLI** | Binary on `PATH`, and a zero-cost subcommand (`--version`, `auth status`, `whoami`) exits 0. |
| **offline export** | A path was supplied, and the file exists and is readable. |

**Never wait on a dead provider.** If a probe shows the connector is not even
present (off-VPN MCP tools do not appear at all), classify it `blocked`
immediately with the probe evidence — do not fire a real call into the void and
hang. For a present-but-slow provider, budget ~60s, retry once with a warning,
then mark `blocked` with the error text. A slow source never stalls the report.

## Classification — three states

| Status | Meaning | How the probe decides it |
|---|---|---|
| **reachable** | The source can be read in full for this task. | Probe passed (tool present + auth ok, or CLI ok, or file present). |
| **blocked** | The source cannot be read at all. | Probe failed: tool absent, auth failed, binary missing, VPN down, no offline copy provided. |
| **partial** | The source responds, but the data comes back incomplete. | Probe (or the first real call) succeeds but returns a truncated or permission-limited result — see below. |

On classifying a source `blocked`, also append an advisory `detent feedback add --kind
blocked-source ...` entry (`engine/self-feedback/CONTRACT.md`) — alongside, never
instead of, the access-degraded gate for a blocked critical source.

### Partial-data detection

`partial` is the dangerous middle: a stage gets *something* back and can fool
itself into treating it as complete. A source is `partial` when any of these
hold, and the `detail` field must say which:

- **Truncated / capped** — the result hit a `maxResults`/page cap the caller
  cannot page past within budget (the source has more rows than were returned).
- **Permission-limited** — some fields, rows, or child items came back
  redacted or access-denied while others succeeded (e.g. a doc readable but its
  linked attachment is not; a query returns aggregate rows but not row-level).
- **Time/scope-limited** — the source only exposes a window (last N days,
  current sprint) shorter than the task needs.
- **Degraded backend** — the connector answered but reported a partial/stale
  backend (a search index still warming, a replica behind).

Partial is not "few results" — a genuine, complete "0 hits" is `reachable`. It
is specifically *the source having more than it gave you*.

### Why a source is blocked — refine it

A bare "blocked" is not actionable. Every `blocked` (and `partial` caused by
auth) records **why**, so the plan gate can show the exact enable action:

| `blocked_reason` | Enable action shown to the human |
|---|---|
| `not-wired` | Wire a connector in the company pack (`stack.<company>.yaml`), then retry. |
| `vpn-not-connected` | Connect VPN, then retry the probe. |
| `auth-needed` | Complete the login/SSO for `<service>`, then retry. |
| `connector-unauthenticated` | Authenticate the `<X>` connector (e.g. run the connector's auth flow), then retry. |
| `interactive-only-context` | Escalate the fetch to the interactive session, or hand over an offline export (design/drive connectors are absent in background contexts). |
| `no-offline-copy` | Provide the offline export at a path. |

## Criticality

Each source carries a `criticality` (`critical | important | optional`). It
starts from the CATALOG default for the source type and is overridden when the
task's own need differs (state the override reason in `detail`). Criticality
does not change the probe — it changes what a `blocked`/`partial` result
*costs*: a blocked **critical** source hard-blocks the plan gate (CONTRACT.md);
important and optional are advisory.

## `access-report.json` schema

An array of source records. One record per needed source.

```json
[
  {
    "source": "tickets",
    "binding": "tracker-mcp",
    "needed_for": "U1 retry policy; precedent tickets",
    "status": "reachable",
    "criticality": "critical",
    "detail": "tracker MCP tools present; whoami ok",
    "blocked_reason": null,
    "enable_action": null,
    "probed_at": "2026-07-05T18:04:11Z"
  },
  {
    "source": "prod-analytics",
    "binding": "query-engine-mcp",
    "needed_for": "F4 dominant failure class — needs real error-rate numbers",
    "status": "blocked",
    "criticality": "critical",
    "detail": "query-engine MCP tools absent from inventory; probe: tool search 'query-engine' -> no match",
    "blocked_reason": "not-wired",
    "enable_action": "Wire the query-engine connector in the company pack, then retry.",
    "probed_at": "2026-07-05T18:04:12Z"
  },
  {
    "source": "docs-wiki",
    "binding": "wiki-mcp",
    "needed_for": "the design decision doc for U2",
    "status": "partial",
    "criticality": "important",
    "detail": "page body readable; 2 linked attachments returned permission-denied (row-level redaction)",
    "blocked_reason": "auth-needed",
    "enable_action": "Complete access for the linked attachments' space, then retry.",
    "probed_at": "2026-07-05T18:04:13Z"
  }
]
```

Field rules:

- `source` — the CATALOG source type.
- `binding` — the concrete provider from the company pack that serves it (or
  `null` if `not-wired`).
- `needed_for` — the specific unknown/finding/conclusion this source feeds.
  "General context" is not a valid `needed_for` — if you cannot name what it
  feeds, it is not a needed source.
- `status` — `reachable | blocked | partial`.
- `criticality` — `critical | important | optional`.
- `detail` — the probe evidence (command/tool + result) for `reachable`, or the
  specific limitation for `blocked`/`partial`. "unreachable" with no evidence is
  not acceptable.
- `blocked_reason` — one of the reasons above, or `null` when `reachable`.
- `enable_action` — the exact action, or `null` when `reachable`.
- `probed_at` — UTC ISO-8601.

## How stages use it

1. **Research** ([../stages/research/SKILL.md](../stages/research/SKILL.md))
   runs the preflight for every source it relies on and writes
   `access-report.json`. Any finding drawn from a `blocked` or `partial` source
   is tagged **degraded-confidence**. Proceeding on a blocked/partial *critical*
   source without surfacing it is a forbidden failure mode.
2. **Plan** ([../stages/plan/SKILL.md](../stages/plan/SKILL.md)) reads the
   report and leads the curator artifact with an **"Access & data
   completeness"** panel: every needed source with its status, the conclusions
   that depend on it, and inline unblock controls (offline-path input, retry,
   proceed-degraded).
3. **The plan gate hard-blocks** on any `blocked` critical source unless the
   human explicitly records "proceed degraded" for it — see the CONTRACT gate
   rule ([../stages/CONTRACT.md](../stages/CONTRACT.md)).

## Forbidden

- **Silent proceed** — using a source's data (or its absence) without a record
  in `access-report.json`.
- **Evidence-free blocked** — a `blocked`/`partial` record whose `detail` does
  not name the probe and its result.
- **Hang-on-dead-provider** — firing a real call at an absent connector instead
  of classifying it `blocked` from the tool-inventory probe.
- **Partial-as-complete** — treating a truncated/permission-limited result as
  the whole source (mis-classifying `partial` as `reachable`).


## Routing to the reads-courier (interactive-only source, headless context)
When a needed source is interactive-only (Figma/Drive/Gmail/Slack/Jira) AND unreachable in the
current context (background subagent / headless run), do NOT hard-fail: route it to the
connector-read courier — `detent courier request --source <s> --query <q> --for <who>` — and surface
it in the plan/brief gate as "requested from your interactive session". A connector-capable
session fulfills it (see the courier skill) and the consumer resumes via `detent courier await <id>`.
This keeps the honest-flag contract (never silently degrade) while still getting the data
without stored credentials. Limit: needs a capable session alive; no-session reads defer.
