# owl — unattended overnight loop for Claude Code

An external bash orchestrator that runs `claude -p` in a loop toward an
objective while you sleep. The orchestrator — not the agent — owns git,
caps, the kill switch, cross-iteration memory, and the morning review.
Design follows the gnhf doctrine: the agent's claims are never trusted;
they are gated (non-empty diff), rolled back on failure, and surfaced the
next morning as **unverified** claims for human accept/reject.

No telemetry, no external fetches, no auto-updates, and **never** a
permissions-bypass flag.

## Usage

```sh
engine/owl/owl.sh \
  --objective "add unit tests for the parser module until coverage stops improving" \
  --repo ~/code/some-repo \
  --max-iterations 8 \        # default 8
  --max-minutes 300 \         # default 300 (wall clock, enforced in bash)
  --stop-when "parser has tests for every public function"   # optional
```

Optional: `--claude-bin <path>` (or env `OWL_CLAUDE_BIN`), `--profile <name>`
to select a permission profile (default `default`), and `--settings-file
<path>` to override the resolved profile entirely (back-compat; wins over
`--profile` if both are given). See "Permission profiles" below.
Trigger from a session with the `/owl` skill (`skills/owl/`).

## What one iteration looks like

1. Orchestrator builds a prompt: objective, optional stop condition,
   "read the notes file first", "next smallest verifiable unit", the hard
   no-git rule, the never-halt decision contract (below), and the JSON
   output contract `{success, summary, key_changes, key_learnings,
   provisional_decisions, should_fully_stop}`.
2. `claude -p --output-format json` runs headless in the target repo under
   the scoped settings (below). The prompt is piped on stdin — untrusted
   text is never shell-interpolated.
3. Orchestrator judges the result:
   - contract violation, nonzero exit, or `success=false` → **failure**;
   - `success=true` but empty diff → **failure** (no-op halt rule);
   - otherwise → `git add -A` (excluding `.owl/`, `.plans/`) and
     `git commit -m "owl <n>: <summary>"` on branch `owl/<slug>`.
4. On failure: `git reset --hard && git clean -fd -e .owl -e .plans`.
5. Learnings (success or failure) are appended by the orchestrator to
   `.owl/notes-<slug>.md`; the agent reads it, never writes it.

Loop halts on: iteration cap, wall-clock cap (a running iteration is
killed at the deadline), 3 consecutive failures (kill switch), or the
agent claiming `should_fully_stop=true` — which is recorded and displayed
as an **unverified claim**, never as truth.

## Never-halt decision contract (the decision journal)

The whole point of owl is progress while nobody is there — so a major
decision the agent cannot settle (ambiguous requirement, competing
designs, missing convention) must **never** stop the loop. The iteration
prompt instructs the agent to pick a defensible provisional path (the most
reversible defensible option), keep working, and report every such call in
the `provisional_decisions` field of its output:
`{decision_needed, options_considered, provisional_choice, rationale,
reversibility}`.

The orchestrator — never the agent — then, for each **committed**
iteration that reported decisions:

- appends one structured entry per decision to
  `.owl/<run>/decisions.jsonl`
  (`{id, iteration, decision_needed, options_considered,
  provisional_choice, rationale, reversibility}`, ids `D-1, D-2, …`
  run-scoped);
- tags the commit subject with `[PROVISIONAL D-n]` (all ids for the
  iteration in one tag) so provisional work is visible straight from
  `git log`;
- echoes the decisions into the notes file so later iterations stay
  consistent with earlier provisional choices instead of re-deciding.

Decisions reported by a **failed** iteration are dropped with the rollback
(logged, not journaled) — there is no kept work to accept or pivot.

Hard limit, regardless of any provisional autonomy: destructive,
irreversible, or security-sensitive actions remain forbidden. The
never-halt contract changes what the agent does at a fork in the road; it
never widens the permission sandbox. If every option would need a
forbidden action, the agent does the safe subset and records that as the
provisional choice.

Every journaled decision is surfaced the next morning in a prominent
**"Decisions I made for you"** section at the top of the review artifact,
one Accept/Pivot gate per decision (see below).

Safety preconditions: the target repo must be clean (dirty tree = loud
refusal, because failed iterations are hard-reset), and a lock dir at
`.owl/lock` prevents two concurrent runs on one repo. On macOS the
run wraps itself in `caffeinate -dims -w <pid>` so the machine stays
awake (`OWL_NO_CAFFEINATE=1` to skip).

Everything is logged to `.owl/<run>/log`; raw per-iteration CLI JSON,
prompts, `iterations.jsonl`, and `run-meta.json` live next to it.

## Morning review

After the loop ends, `morning-review.sh` writes
`.plans/owl-review-<date>.html` into the target repo — a
self-contained, script-free HTML artifact (curator-compatible). At the
**top**, before anything else: the **"Decisions I made for you"** section —
one card per journaled provisional decision (what needed deciding, options
considered, the provisional choice, rationale, reversibility, the tagged
commit) with a `data-plan-question` **Accept/Pivot** block each; Pivot
means "annotate with the direction you actually want". Then one card
per iteration with commit sha, claimed summary/changes/learnings, and a
`data-plan-question` Accept/Reject decision block per commit, all under a
banner stating that **stop-condition claims are UNVERIFIED**. If
`curator` is on PATH the run log's final `next_step` is
`curator open <artifact>`; otherwise open the file in a browser.

Nothing in `.owl/` or `.plans/` is ever committed by the loop.

## Permission profiles

Permission surfaces live as JSON files in `engine/owl/profiles/` — the exact
shape `claude -p --settings` expects, so no transform and no extra
dependency beyond the `jq` owl already requires. Profiles are shareable
policy (unlike `detent.user.yaml`, which is scoped to inherently-personal
values), so they are versioned in the repo, not the user config.

**Resolution order** (first match wins): `--settings-file <path>` (back-compat
escape hatch — always wins if given) > `--profile <name>` (looks up
`profiles/<name>.json`) > the `default` profile if neither flag is given. An
unknown `--profile` name dies with the list of profiles actually present in
`profiles/*.json`.

**Validation** — every resolved settings file, regardless of which flag
selected it, is run through `validate_profile()` before anything else in the
run happens. It dies (refusing the run) if the file:

- is not parseable JSON;
- sets `defaultMode: "bypassPermissions"` anywhere — bypass is banned for
  owl even for unattended runs (see "Honest limitations" below); this makes
  that doctrine mechanical instead of just documented;
- grants blanket Bash in `allow` (`"Bash"` or `"Bash(*)"`) — owl requires a
  scoped Bash allowlist, not a blanket shell;
- grants bare `"WebFetch"` or `"WebSearch"` in `allow` — network access must
  be prefix-scoped, e.g. `"WebFetch(domain:example.com)"`.

**Adding a project profile:** copy `profiles/default.json` (the
network-off-by-default baseline) or `profiles/example-net-allowlist.json`
(adds a `WebFetch(domain:...)` allowlist entry) into a new
`profiles/<name>.json`, edit its allow list to add your project's verify
commands, and run with `--profile <name>`. Prefer this over `--settings-file`
so the profile is discoverable and reusable; `--settings-file` remains for
one-off or out-of-repo files.

Exact flags passed to `claude -p` per iteration:

| Flag | Why |
|---|---|
| `--permission-mode dontAsk` | Headless: anything not explicitly allowed is **denied**, never prompted (a prompt would hang the run). |
| `--settings <resolved profile path>` | The scoped allow/deny surface, resolved and validated as above. |
| `--setting-sources project` | Your user-level global grants are NOT loaded; only the target repo's own project settings plus our file. |
| `--disallowedTools "Bash(git commit*)" …` | CLI-level reinforcement of the git denials. |
| `--output-format json` | Machine-readable envelope for the contract. |

The `default` profile allows: `Read`, `Glob`, `Grep`, `Edit`, `Write`,
and a Bash allowlist of common verify commands (git read-only, npm/pnpm/yarn
test+run, node, pytest, go test/build/vet, cargo test/build/check, make,
gradlew, mvn, plus ls/cat/grep/rg/find/etc.). It denies: all git
write commands, sudo, network clients (curl/wget/ssh/scp/rsync/nc/telnet),
`WebFetch`/`WebSearch`, reads of `.env*`/`~/.ssh`/`~/.aws`, and writes to
`.owl/`/`.plans/`. It also sets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_TELEMETRY=1`.

## Permission model — the honest version

Honest limitations — read these before trusting the setup:

- **The deny list is prefix matching, not a security boundary.** An agent
  that can `Write` a script and run it via an allowed command (e.g.
  `make`, `npm run`, `node`) can execute arbitrary code, including git
  commands. The *real* commit-control guarantee is orchestrator-side:
  only the orchestrator runs `git commit`, and every failed iteration is
  hard-reset. Treat the deny list as guardrails against accidents, not
  malice. `validate_profile()`'s string-matching guard (below) carries the
  same caveat — it catches an obviously-banned rule, it does not prove the
  resulting sandbox is airtight. For actual containment, run the whole
  thing in a VM/container or rely on Claude Code's OS sandbox.
- **The allowlist will not fit every project.** If your verify command
  isn't covered, iterations fail with permission denials (visible in
  `.owl/<run>/claude-stderr.log` and as failed iterations). The right
  fix is a *scoped* project profile under `profiles/<name>.json` (or a
  one-off file passed via `--settings-file`) that adds exactly the
  commands your build needs — **never** `--dangerously-skip-permissions` or
  `--permission-mode bypassPermissions`. Those flags are banned here even
  for fully unattended runs, and `validate_profile()` now refuses any
  profile that sets `defaultMode: bypassPermissions`, so this is enforced,
  not just documented — even for a permissive file you hand it via
  `--settings-file` on purpose. If a run can't proceed inside an explicit
  allowlist, that's a signal to narrow the objective, not to remove the
  guardrails.
- **`--setting-sources project` loads the target repo's own
  `.claude/settings.json`**, including its hooks and any permissive rules
  it declares. Point the loop only at repos you trust.
- **Auth**: the loop uses whatever credentials `claude` resolves
  (keychain OAuth or `ANTHROPIC_API_KEY`). We deliberately do not use
  `--bare` so OAuth keeps working unattended; on a headless remote box
  set `ANTHROPIC_API_KEY`-based auth yourself. There is **no hard token
  cap** — per-iteration cost is recorded from the CLI JSON into
  `iterations.jsonl`, but enforcement is only via the iteration and
  wall-clock caps.
- **Everything the agent "verified" is self-reported.** The orchestrator
  checks exactly one objective fact: the diff was not empty. The morning
  review exists because the claims need a human.

## Intervention points and the human gate

owl runs headless — nobody is present to answer a mid-run question — so its
design deliberately concentrates every point where a human actually gets a
say into exactly three, and nowhere else:

1. **Pre-launch gate** — the `/owl` skill's mandatory confirmation (repo
   path + clean tree, iteration/wall-clock caps, stop condition, permission
   profile) before anything is launched. This is the only point where the
   human decides *whether the run happens at all*.
2. **Mid-run kill switch** — once launched, the only ways a run stops before
   its natural halt are `kill <PID>` (the human), the 3-consecutive-failure
   halt, or the wall-clock cap. There is deliberately **no mid-run
   question** — the run is headless by design, and the never-halt contract
   exists precisely so the agent never needs to stop and ask.
3. **The ticket gate** — when the agent hits a major decision it cannot
   settle, owl never halts to ask about it. It parks the provisional choice
   in the decision journal (`.owl/<run>/decisions.jsonl`, tagged
   `[PROVISIONAL D-n]` on the commit) and keeps working. The human gate for
   that decision lives downstream, at the Jira ticket / morning review: the
   morning artifact surfaces every provisional decision for Accept/Pivot,
   and an accepted-or-pivoted decision is posted back to the ticket by the
   human or an interactive session — **never by owl itself**, which has no
   network access by design (see the `default` permission profile above).

Nothing here is new machinery — the decision journal, `[PROVISIONAL D-n]`
tagging, and the morning-review Accept/Pivot blocks already existed; this
section just names the convention so it's discoverable without reading the
orchestrator source.

## Tests

```sh
engine/owl/test/run-tests.sh
```

A fake `claude` binary (`test/fake-claude`) honors the JSON contract and
is scripted per-invocation (`edit-success`, `fail`, `noop-success`,
`stop`, `garbage`, `sleep-N`, `decide`, `decide-fail`), and records its own
argv per invocation so tests can assert what actually reached the
invocation. The harness proves commit-on-success, reset-on-failure,
no-op-is-failure, the 3-failure kill switch, the iteration cap, the
wall-clock kill, notes accumulation, stop-claim handling,
contract-violation handling, dirty-tree refusal, morning artifact
generation, the never-halt decision journal (journal entry schema,
`[PROVISIONAL D-n]` commit tag, notes echo, "Decisions I made for you"
rendered above the iteration cards, and rolled-back decisions staying out
of the journal), and the permission-profile mechanism (default-profile
resolution reaching the claude invocation, the default profile's
network-off-by-default config, the bypass/blanket-Bash/bare-network
`validate_profile()` guards, and the unknown-profile error) — 88
assertions.

Note on what these tests do *not* prove: the harness drives the fake
`claude` stub, not a real one, so it cannot honestly exercise real
permission *enforcement* (a network op actually being denied at runtime).
What it proves instead — config-parse assertions on the resolved profile,
and wiring assertions that the resolved settings path actually reaches the
claude invocation's argv — is the scope this suite claims. See "Deferred"
below for the real end-to-end test.

## Deferred

Not in scope for the permission-profiles work above; noted so it isn't
mistaken for coverage that exists:

- **Sandbox enforcement depth.** Real OS/network containment (VM/container,
  Claude Code's OS-sandbox `allowedHosts`) — the deny rules and
  `validate_profile()` guard remain accident-guards, not containment.
- **A real end-to-end test that a live `claude` binary denies a network
  op.** Needs a live binary and tokens and would be non-deterministic;
  the honest alternative implemented here is config-parse + wiring
  assertions (see "Tests" above).
- **owl → Jira automation for the ticket gate.** owl is network-less by
  design, so posting an accepted-or-pivoted decision back to the ticket
  stays a human/interactive-session step for now (future herald/sentinel
  integration).
- **Per-path Write/Edit allowlists per profile** beyond the existing
  `.owl/`/`.plans/` denies, and purpose-built profiles (docs-only,
  tests-only).
