# engine dashboard — the run-status view over the centralized `.sdlc/`

One command answers "where is everything?": `engine dashboard` (in
`engine/cli/engine.mjs`) reads EVERY run directory under the centralized
`${DETENT_ROOT}/.sdlc/` and renders them into a single self-contained curator
artifact. Runs are centralized in the detent clone (see
[`../CONTRACT.md`](../CONTRACT.md)), so one dashboard covers all active work —
across every work repo and machine session pointing at this detent home.

## What it shows, per run

| Field | Source | Meaning |
|---|---|---|
| `run_id`, `ticket_ref`, `repo` | `run.json` | identity + which work repo the change lands in |
| `worktree`, `branch` | `run.json` | the run's working area (default worktree flow) |
| `stage` | `stage-status.json` | first stage not `done` (`null` = run complete) |
| `stage_status` | `stage-status.json` | `pending` / `in_progress` / `blocked` / `done` |
| `blocked_on` | `stage-status.json` | decision ids the current stage is blocked on |
| `pending_gates` | `decisions.json` | every pending decision: id, gate name, question, blocked stages |
| `created_at`, `age` | `run.json` | run age, human-readable (`45m`, `7h`, `3d`) |

A run whose `stage-status.json` is missing is reported loudly
(`stage_status: "unreadable (stage-status.json missing)"`), never skipped.

## Output

1. **One JSON line** on stdout: `{ok, sdlc_home, runs[], artifact, next_step}` —
   the machine-readable assembly (this is what the tests freeze).
2. **The curator artifact** at `${DETENT_ROOT}/.plans/engine-dashboard.html`:
   self-contained per the curator skill's rules (inline CSS, system font stack,
   `color-scheme: light dark`, no external URLs). Decision questions and all
   other run-derived text are HTML-escaped — they are untrusted input.
3. **`next_step`** prints the curator open command
   (`node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" open <artifact>` when the curator is
   present; `curator open <artifact>` when a curator binary is on PATH; a
   plain-browser fallback otherwise).

Per the curator-via-subagents rule (CONTRACT.md, "Curator via subagents"),
opening and polling the dashboard is delegated to a subagent; the main
conversation receives only the distilled status summary.

## Exit behavior

- No runs (or no `.sdlc/` yet): exit 0, `runs: []`, artifact still written —
  an empty dashboard is a valid answer, not an error.
- The command only READS run state; it never mutates `stage-status.json`,
  `decisions.json`, or any run artifact.

## Tests

```
node --test engine/cli/tests/dashboard.test.mjs
```

Covers: empty-home behavior, multi-run/multi-repo aggregation (stage, status,
pending gates, age), artifact self-containment (inline CSS, no external URLs),
the open `next_step`, and HTML-escaping of untrusted decision text.
