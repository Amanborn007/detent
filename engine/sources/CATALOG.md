# Source catalog — the data sources a run may need, and how reachable they are

**Takeaway: before a stage relies on a source, it looks the source up here to
learn how that source is normally reached and how likely it is to be reachable
right now.** This catalog is the generic, company-agnostic list of source
*types*. It does not name any tool. Concrete provider bindings — which MCP
server, which CLI, which login — live in the company adapter pack
(`stack.<company>.yaml` and its skills), never in `engine/`.

Two files work together:

- **This file (CATALOG.md)** — the static map: what kinds of source exist, how
  each is typically reached, how reachable it usually is, and how critical it
  is by default.
- **[PREFLIGHT.md](PREFLIGHT.md)** — the runtime contract: given the sources a
  task actually needs, probe each one, classify it `reachable | blocked |
  partial`, and write `access-report.json`.

## Why this exists

A stage that silently proceeds on a source it could not read produces a
confident answer built on a hole. The rule across detent is the opposite:
**a source that is blocked or only partially available is called out
explicitly, at the planning phase, before any conclusion rests on it.** This
catalog is step one — it tells a stage what "reachable" should even look like
for a given source, so "I couldn't reach it" is a checkable claim and not a
shrug.

## Access methods

How a source is reached at all. The company pack binds each to a real tool.

| Method | What it means | Presence check |
|---|---|---|
| **MCP connector** | A tool exposed by an MCP server in the session (search, fetch, query). | The tool appears in the session's tool inventory. Absent tool = cannot call it. |
| **CLI** | A command-line tool invoked with a subprocess (VCS client, tracker CLI, cloud CLI). | The binary is on `PATH` and a cheap subcommand (`--version`, `whoami`, `auth status`) exits 0. |
| **offline export** | No live connection: a file a human exported and handed over (a doc download, a CSV, a screenshot). | A path was provided and the file exists and is readable. |

## Reachability tiers

How likely a source is to be reachable, as a static default. This is the
*expectation*; PREFLIGHT.md probes the actual state per run.

| Tier | Meaning | Typical enable action when not reachable |
|---|---|---|
| **always** | Reachable from any context — no VPN, no interactive login. Local files, the checked-out repo, a public CLI. | (usually reachable; if not, the specific error is the action) |
| **interactive-only** | Needs a connector authed only in the human's interactive session; **absent in background/subagent contexts** (e.g. design and drive connectors). | Escalate the fetch to the interactive session, or hand over an offline export. |
| **vpn** | Reachable only on the corporate network / VPN. Off-VPN the tool may not even appear. | Connect VPN, then retry the probe. |
| **not-wired** | No binding exists in the company pack for this source type yet. | Wire a connector in the pack (`stack.<company>.yaml`), then retry. |

When a source is unreachable, PREFLIGHT.md refines *why* into one of
`not-wired | vpn-not-connected | auth-needed | connector-unauthenticated`, so
the plan gate can show the **exact** enable action ("connect VPN", "complete
auth for `<service>`", "wire the connector", "authenticate the `<X>`
connector") rather than a generic "blocked".

## Criticality defaults

How much a blocked source should hurt. This is the *default* for the source
type; a task overrides it when its own needs differ (a docs source is usually
`important`, but for a "summarize this one design doc" task it is `critical`).

| Criticality | Meaning | Effect when blocked |
|---|---|---|
| **critical** | The task's core conclusions cannot be trusted without it. | **Hard-blocks the plan gate** unless the human explicitly picks "proceed degraded" (see PREFLIGHT.md and the CONTRACT gate rule). |
| **important** | Materially improves the result; its absence degrades confidence. | Advisory: surfaced prominently, dependent findings tagged degraded-confidence, but does not block. |
| **optional** | Nice to have; corroborating or background. | Noted; low-weight. |

## The catalog

Source *types* a detent run may need. `Access` and `Reachability` are the
common case; the company pack's binding can move a row (e.g. a tracker reached
by a cloud MCP is `vpn`, one reached by a public CLI is `always`).

| Source type | What it holds | Typical access | Reachability | Criticality default |
|---|---|---|---|---|
| **code / VCS** | The repo(s) under change: source, history, config, in-repo docs. | CLI (local checkout + VCS client); MCP for org-wide code search. | always (local checkout) · vpn (org search) | **critical** — you cannot plan a code change you cannot read. |
| **tickets / tracker** | The work item, its links, comments, prior/duplicate tickets. | MCP connector or CLI. | vpn or interactive-only, per binding. | **critical** for the driving ticket; important for precedent tickets. |
| **docs / wiki** | Design docs, ADRs, runbooks, PRDs, decision records. | MCP connector (wiki search/fetch); offline export. | vpn or interactive-only. | important (critical when the task is "act on doc X"). |
| **design** | UI/UX specs, mockups, component libraries, exported frames. | MCP connector (design tool); offline export (screenshot / exported frame). | interactive-only — design connectors are authed only in the human session. | **critical** for any UI/UX task; not-applicable otherwise. |
| **files / drive / sheets** | Shared drives, spreadsheets, attached documents. | MCP connector (drive); offline export. | interactive-only. | important (task-dependent). |
| **chat** | Slack/Teams threads, channels, decisions made in chat. | MCP connector. | vpn or interactive-only. | optional–important — often corroborating, occasionally the only record of a decision. |
| **prod analytics / query** | Live product data, warehouse/query engine, event streams. | MCP connector or CLI, usually behind auth + VPN. | vpn (often not-wired until a connector is added). | **critical** when a conclusion rests on real numbers; otherwise important. |
| **dashboards / BI** | Pre-built metrics, monitoring, saved reports. | MCP connector; offline export (screenshot of a panel). | vpn or interactive-only. | important. |

### Design and drive are interactive-only — the recurring trap

Design and drive connectors are authenticated **only in the human's
interactive session**. A background run or subagent does not inherit them: the
tool is simply not in its inventory. This is not a sandbox-permission gap and
cannot be fixed by retrying in the same context. The correct handling:

- a UI/UX task with no attached design (link + node / export / screenshot) is a
  **blocked critical source** — surface "I need the design", never guess the
  visual;
- route the design/drive fetch to the interactive session, or take an offline
  export path;
- verify any external identifier (a flag name, an experiment key, an API path)
  against its real source before using it — a plausible-but-wrong identifier is
  worse than a flagged gap.

## Where bindings live

This file is deliberately abstract. The concrete answer to "which MCP server is
the tracker" or "what command reaches the query engine" is company-specific and
lives in the adapter pack alongside the socket definitions
(`engine/stack.example.yaml` shows the socket shape; a real pack fills it in).
PREFLIGHT.md reads those bindings to know *what* to probe; this catalog tells it
*what a healthy probe looks like* and *how much a failure matters*.
