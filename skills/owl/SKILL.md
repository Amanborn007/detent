---
name: owl
version: 1.0.0
description: >-
  Run the loop unattended overnight, under caps you confirm first.
disable-model-invocation: true
allowed-tools: >-
  Bash(*/engine/owl/*), Bash(git status*), Bash(git rev-parse*),
  Bash(nohup *), Bash(tail *), Bash(ls *), Bash(cat *), Bash(command -v *),
  Read, AskUserQuestion
---

# /owl — launch an overnight loop

You are setting up an UNATTENDED run. Everything you get wrong here executes
for hours with nobody watching, so the gate below is mandatory.

Orchestrator path — resolve it relative to this skill's own directory, which
works wherever the detent repo is checked out:

```
${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-<skill-dir>/../..}}/engine/owl/owl.sh
```

i.e. the PRIMARY path is `<skill-dir>/../../engine/owl/owl.sh` (this
skill lives at `skills/owl/` inside the detent repo, two levels above is
the repo root). Read `engine/owl/README.md` (same repo root) for the
mechanics and the permission model before answering user questions about it.

**Installing into `~/.claude/skills`:** if you COPY this skill directory there
(instead of referencing it in place), `<skill-dir>/../..` no longer points at
the detent repo — set the `DETENT_ROOT` environment variable to your detent
clone's root, and the command above picks it up.

## Step 1 — validate the objective is loop-suitable

The loop only works for objectives that are **incremental** (decomposable into
small units, each committable on its own) and **verifiable** (each unit has a
runnable check — tests, build, lint — inside the target repo, with no human
judgment or external approval in the loop). Also require **bounded blast
radius**: one repo, no deploys, no network side effects, nothing irreversible.

Reject (and say why, offering a reformulation) objectives like:
- "make the app better", "refactor tastefully" — not verifiable;
- "ship the release", "migrate the prod DB" — irreversible / not sandboxed;
- anything requiring credentials, external services, or approval from a human
  mid-loop — the agent runs headless and cannot ask.

Design forks are NOT a reason to reject: the loop runs a **never-halt
decision contract** — a major decision the agent cannot settle never stops
the run. It picks a defensible provisional path, the orchestrator journals
it to `.owl/<run>/decisions.jsonl` and tags the commit
`[PROVISIONAL D-n]`, and the morning review presents every such decision
for accept/pivot. Tell the user this when they worry the objective has
open questions. What never changes: destructive, irreversible, or
security-sensitive actions stay forbidden — provisional autonomy does not
widen the sandbox.

Good shape: "add tests for X until every public function is covered",
"fix all lint errors in packages/y", "port module Z to TypeScript file by
file, keeping the build green".

If the objective is weak, propose a tightened version plus a concrete
`--stop-when` condition, and get the user's agreement on the wording.

## Step 2 — confirm the run parameters (mandatory gate)

Check and confirm with the user (AskUserQuestion is fine):
1. **Repo path** — must be a git repo with a **clean working tree**
   (`git status --porcelain`); warn that failed iterations are rolled back
   with `git reset --hard` and that the loop commits to a `owl/<slug>`
   branch, never to the user's current branch.
2. **Caps** — max iterations (default 8) and max minutes (default 300).
   State them back explicitly; do not launch on silence.
3. **Stop condition** — optional `--stop-when` text; remind the user the
   agent's "stop condition met" claim is treated as UNVERIFIED either way.
4. **Permissions** — the run uses a permission profile from
   `engine/owl/profiles/` (JSON, selected via `--profile <name>`, default
   `default`) with `--permission-mode dontAsk`. Offer `--profile default`
   unless the user has (or wants) a project-specific profile. If the
   project's test/build commands are not in the chosen profile's allowlist,
   tell the user iterations will fail on permission denials and offer to
   copy `engine/owl/profiles/default.json` into a new
   `engine/owl/profiles/<name>.json` (or a one-off file for
   `--settings-file`) with the extra commands added. NEVER offer
   `--dangerously-skip-permissions` or `bypassPermissions` — they are banned
   for this loop, and `owl.sh` refuses any profile that sets one.

## Step 3 — launch detached

Launch so the loop survives this session ending (argv-safe — pass the
objective as a single quoted argument, never build a shell string from it):

```sh
nohup "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-<skill-dir>/../..}}/engine/owl/owl.sh" \
  --objective "<objective>" \
  --repo "<repo>" \
  --max-iterations <N> --max-minutes <M> \
  ${STOP_WHEN:+--stop-when "<condition>"} \
  >/dev/null 2>&1 &
```

Capture the PID (`$!`). The script logs everything itself to
`.owl/<run>/log` inside the target repo, keeps the machine awake via
`caffeinate` on macOS, and generates the morning artifact when done.

## Step 4 — report how to monitor

Tell the user, concretely:
- **Watch live:** `tail -f <repo>/.owl/<run>/log` (name the actual run
  dir — it is the newest directory under `<repo>/.owl/`).
- **Stop early:** `kill <PID>` (also releases the machine-awake wrapper);
  the lock dir `<repo>/.owl/lock` must be removed if the process is
  killed uncleanly.
- **Morning:** review `<repo>/.plans/owl-review-<date>.html` — via
  `curator open <file>` if curator is installed. The **"Decisions I made
  for you"** section at the top lists every provisional decision the loop
  made under the never-halt contract — accept or pivot each one FIRST (a
  pivot usually decides several commits' fate at once), then accept/reject
  each commit; every success in it is an unverified agent claim.
- **Branch:** results are on `owl/<slug>`; nothing was pushed.
- **Ticket gate:** owl never halts mid-run to ask about a decision — it
  parks the provisional choice in the decision journal instead, and the
  human gate is here, at morning review; once a decision is accepted or
  pivoted, posting that back to the Jira ticket is a step for the user or
  an interactive session, never owl itself (it has no network access).
