# hooks/

Claude Code hooks that make the pack's PR loop and the curator review loop run
without the human having to remember anything.

**This directory is the CANONICAL hook set for detent adopters.** The engine also
documents two curator trigger hooks (`engine/curator-triggers/hooks.md`) — that file
is engine-internal documentation of the upstream originals; detent users install the
scripts here, which are self-sufficient and already wired for this repo's layout.

The hooks:

| Script | Event / matcher | Purpose |
|---|---|---|
| `sentinel-autoscan.sh` | PostToolUse, matcher `Bash` | Detect a PR becoming watchable (create/ready/push), spawn a detached read-only bot-comment scanner. |
| `sentinel-inbox-check.sh` | Stop | The reader half of the above: hold the stop open while the scanner's inbox has unacked rounds, an open blocking gate, or a live poll, so the fix→push→rescan loop runs its configured rounds instead of dying with the turn. |
| `curator-reminder.sh` | PostToolUse, matcher `ExitPlanMode` | After a plan is approved, remind the agent to render it in curator and run the feedback loop before implementing. |
| `curator-md-nudge.sh` | PostToolUse, matcher `Write\|Edit` | When a large markdown deliverable is written, nudge toward a curator artifact instead. |
| `curator-stop-check.sh` | Stop | Safety net: block the stop once if the turn produced a review-shaped deliverable but curator was never opened. |
| `deslop-check.sh` | PostToolUse, matcher `Bash` | After a `git push` with a code-ish diff vs main, nudge the agent to run referee's deslop lens (`/deslop`) to strip AI slop. |
| `eval-gate.sh` | PostToolUse, matcher `Bash` | After a `git push`/`gh pr create` touching engine-eval-relevant paths, nudge the agent to run `engine eval --changed` and report the verdict on the PR. |
| `comment-discipline.sh` | SessionStart **and** PostToolUse, matcher `Write\|Edit` | Inject the code-comment standard (minimal, why-only, ticket key instead of prose) once per agent — subagents get their own — so comments start short rather than getting stripped at review. |
| `voice-discipline.sh` | SessionStart **and** PostToolUse, matcher `Write\|Edit` | Complement of the above, gated on prose files instead of code: re-inject the user's authored-prose voice once per agent, naming the file set by `voice.file` in `detent.user.yaml`, so documents, runbooks and artifacts are written in their voice the first time rather than corrected turn by turn. |

### settings.json snippet (ready to paste)

Add to `~/.claude/settings.json` (or the project's `.claude/settings.json`), adjusting
the absolute path to your clone of this repo:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/comment-discipline.sh",
            "statusMessage": "Code-comment discipline"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/sentinel-autoscan.sh"
          }
        ]
      },
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/curator-reminder.sh",
            "statusMessage": "Curator reminder"
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/curator-md-nudge.sh",
            "statusMessage": "Curator markdown nudge"
          },
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/comment-discipline.sh",
            "statusMessage": "Code-comment discipline"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/curator-stop-check.sh",
            "statusMessage": "Checking curator was used"
          },
          {
            "type": "command",
            "command": "/absolute/path/to/detent/hooks/sentinel-inbox-check.sh",
            "statusMessage": "Checking the sentinel autoscan inbox"
          }
        ]
      }
    ]
  }
}
```

If your settings.json already has `PostToolUse` / `Stop` arrays, merge these entries
into them instead of replacing. The three curator hooks self-disable when `curator`
is not installed, so it is safe to install them all at once.

Install `sentinel-autoscan.sh` and `sentinel-inbox-check.sh` together. The first writes
rounds to the inbox and the second is what acts on them; the writer alone gives you a
scanner whose results nobody reads.

## sentinel-autoscan.sh — bot comments arrive ~5 min after you push; catch them automatically

You push a non-draft PR. Your review bots (AI PR reviewers, `claude[bot]`,
format-compliance, semgrep, ...) comment about five minutes later — long after the
agent turn that pushed has ended. Without this hook someone has to remember to go back
and collect the findings. With it:

1. **Detect** (PostToolUse hook, matcher `Bash`) — fires when the session runs a
   successful `gh pr create` without `--draft`, a `gh pr ready`, or a `git push` on a
   branch whose PR is open. The command-text regex is only a cheap first filter (it can
   match quoted text like `grep 'git push'`); the decisive gate is live confirmation:
   immediately before spawning, the hook re-checks the resolved PR with
   `gh pr view --json state,isDraft` and only proceeds for an **open, non-draft** PR.
   Drafts are skipped with a logged reason (bots do not review drafts).
2. **Wait & scan, detached — per commit, not per PR event** — spawns a detached
   scanner (survives the session) that polls in per-commit WINDOWS. Each window
   targets one head SHA: sleep 330 s (a first attempt — bots often need ~5 min, but
   the delay is not an assumption that they are done), then `sentinel scan`
   (read-only, from `engine/sentinel/`) with
   `config/sentinel/default.json`, up to 8 rounds with a 5-minute
   debounce (`SENTINEL_AUTOSCAN_MAX_ROUNDS` — a polling axis for this one commit,
   NOT sentinel's own fix-round cap; that is `config.max_iterations`, see below).
   Convergence is only trusted once at least one PR comment has arrived
   since the window started — a comment-less PR looks "converged" to sentinel, so
   the scanner keeps polling until the bots actually speak for that commit (or the
   round cap hits). When a NEW head commit is detected mid-window, the window
   restarts for the new SHA (fresh delay + round budget, up to 12 windows), because
   bots re-review every push — `SENTINEL_AUTOSCAN_MAX_WINDOWS` must exceed
   `config.max_iterations` (default 10), since each fix round pushes once and opens
   a new window. One scanner per PR (atomic mkdir lock) — repeated
   pushes don't stack scanners; the running scanner picks the new commit up itself.
3. **Deliver** — every round appends a `sentinel_scan` JSON line (tagged with the
   commit's `head_sha`) to
   `<detent-clone>/.local/inbox/<owner>__<repo>__pr<N>/respond-inbox.jsonl` (base dir
   overridable via `DETENT_INBOX_DIR`) — inside the detent clone (gitignored), not
   the working repo, so results survive worktree pruning and never dirty the checkout
   you pushed from. Legacy `~/.detent` state migrates with
   `scripts/migrate-local-state.sh`. A round whose scan fails or
   returns unparseable output appends a loud `sentinel_scan_error` line instead — no
   round is ever silently dropped. Each round's log line records
   `actionable=N blocking_open=N converged=…`, and a round writes a markdown
   artifact whenever there are actionable findings OR `blocking_open > 0` — a
   blocking finding that dedup silenced out of `new_findings` still needs a
   human-readable artifact, since it's real even when it isn't new. The artifact
   (untrusted-data warning on top; every bot excerpt fenced with backticks escaped)
   prints an "Open BLOCKING findings" count (sticky vs. unresolved bot threads)
   plus a warning when review threads weren't scanned (the count is a lower bound)
   or when a bot's severity went unparsed (indeterminate, never assumed safe); it
   is written next to the inbox and its path appended as a `curator_artifact` line,
   so the next agent session (or the human) picks the findings up from the inbox
   instead of re-polling GitHub.

The scanner only **reads** the PR. It never posts comments, never edits code, never
replies to bots — acting on the inbox is the sentinel loop's job, with its own
policies (`config/sentinel/default.json`) deciding auto-address vs. escalate.

### Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `SENTINEL_AUTOSCAN` | `on` | Set `off` to disable the hook entirely |
| `SENTINEL_AUTOSCAN_DELAY` | `330` | Seconds before the first scan of each window (bots need ~5 min); set to `5` for testing |
| `SENTINEL_AUTOSCAN_DEBOUNCE` | `300` | Seconds between scan rounds |
| `SENTINEL_AUTOSCAN_MAX_ROUNDS` | `8` | Max rounds per polling window (one window = one head commit) — a polling axis, distinct from sentinel's own fix-round cap (`config.max_iterations`) |
| `SENTINEL_AUTOSCAN_MAX_WINDOWS` | `12` | Max new-commit window restarts per scanner; must exceed `config.max_iterations` (default 10) since each fix round pushes once |
| `SENTINEL_HEAD_CMD` | gh pr view | Test override: command printing the PR head SHA |
| `SENTINEL_COMMENTS_SINCE_CMD` | gh api | Test override: command printing the number of PR comments since `$SINCE` |
| `DETENT_INBOX_DIR` | `<detent-clone>/.local/inbox` | Base inbox dir; per-PR outputs live in `<base>/<owner>__<repo>__pr<N>/` |
| `SENTINEL_BIN` | `engine/sentinel/sentinel.mjs` | sentinel entry point |
| `SENTINEL_CONFIG` | `config/sentinel/default.json` | Bot policy config for the scan |
| `SENTINEL_STATE_DIR` | `~/.sentinel` | sentinel's own "seen comment IDs" state (passed through) |

### Testing the mechanics (no waiting, no posting)

Pasted verbatim, this fires against this repo's own PR 1 — substitute your own PR URL
(any real, open PR; the `tool_response` URL is what trigger 1 parses):

```sh
printf '%s' '{"tool_input":{"command":"gh pr create --title t --body b"},"tool_response":{"stdout":"https://github.com/Amanborn007/detent/pull/1"},"cwd":"'"$PWD"'"}' \
  | SENTINEL_AUTOSCAN_DELAY=5 SENTINEL_AUTOSCAN_MAX_ROUNDS=1 \
    DETENT_INBOX_DIR="$TMPDIR/autoscan-test-inbox" \
    SENTINEL_STATE_DIR="$TMPDIR/autoscan-test-state" \
    hooks/sentinel-autoscan.sh
sleep 8 && cat "$TMPDIR"/autoscan-test-inbox/*/respond-inbox.jsonl "$TMPDIR"/autoscan-test-inbox/*/sentinel-autoscan.log
```

`sentinel scan` is read-only, so pointing this at any real PR is safe. Note: if the PR
is a **draft** (Amanborn007/detent#1 may be), the hook correctly refuses to spawn
and the log shows the skip reason — that is the draft-guard working, not a failure.
Offline unit tests (scan-error loudness, artifact escaping, lock behavior):
`bash hooks/tests/test-sentinel-autoscan.sh`.

## sentinel-inbox-check.sh — keep the loop running until the bots are actually done

The scanner above is only the writing half. Every round it appends lands in
`respond-inbox.jsonl`, and until this hook existed nothing read that file unless a
`respond` run happened to be in flight — so once a turn ended, the rounds that arrived
after the fix push went into a file nobody opened. The visible symptom is a loop that
runs two rounds and stops rather than the `config.max_iterations` cap (default 10).

This Stop hook is the reader, built the same way `referee-owed-check.sh` is for referee
dispatches. It reads the newest `sentinel_scan` line in each recently-touched PR inbox
and holds the stop open in three states:

| State | Condition | What the agent is told to do |
|---|---|---|
| news | **any** round in the file has findings or escalations whose fingerprint is not in `sentinel-acked` | run the `respond` loop on them |
| failed | an unacked `sentinel_scan_error` round — the scan never produced findings | read `sentinel-autoscan.log`, re-run the scan, act on the result |
| waiting | no news and the scanner pid is still alive (including before its first scan, when the inbox file does not exist yet) | `sleep $SENTINEL_AUTOSCAN_DEBOUNCE` and re-read the inbox, do not push again |
| blocked | the scanner has finished and the latest round still reports `blocking_open > 0`, unacked | close each blocking finding: fix, push, reply in-thread, resolve |

Two properties the states depend on. `new_findings`/`human_escalations` are a
**delta** — sentinel reports a finding once, so a later quiet round does not
retire an earlier noisy one and every unacked round has to be checked, not just
the last line. `blocking_open` is **state**, recomputed every scan, so only the
latest round's count is current. Waiting outranks blocked because the bot may
still clear the gate on this commit, and pushing again to chase it is the
eager-rescan failure mode `respond` forbids. `converged` never gates any of
this: it is bot-only, so it can be `true` alongside an open human escalation.

A round is retired by appending the `[ack: ...]` value the hook prints beside it to that
inbox's `sentinel-acked`. The fingerprint is `<head_sha>:<round>:<event-ts>` — the
timestamp is in there because `round` restarts at 1 for every scanner process while
`sentinel-acked` persists, so `<head_sha>:<round>` alone would let a later scanner's
round 1 inherit an older ack and vanish. Everything else that could spin is bounded too: a re-stop
(`stop_hook_active`) carrying findings or an open gate is held only when that state differs
from what the hook last blocked on — recorded per inbox in `sentinel-lastblock`, keyed by
session id, so an unchanged re-stop allows while a newly arrived round still holds. The key
matters: `stop_hook_active` only says *some* hook blocked, so without it a second session
could inherit a suppression for a round it was never shown. **Waiting is exempt from
that suppression**: the advised sleep is shorter than the scanner's first delay, so the next
stop legitimately sees the same wait fingerprint, and allowing it would end the session
before round 1 ever lands. Waiting is bounded by `SENTINEL_STOP_MAX_WAITS` instead (recorded in
`sentinel-waits` and counted **per head SHA**, so each new commit gets its own budget
rather than inheriting an exhausted one), and an inbox is only considered when its
scanner is alive or its inbox file was written in the last day, so merged and abandoned
PRs stop nagging. `PR_AUTOREVIEW=off`, `SENTINEL_AUTOSCAN=off`, or a background job
(`CLAUDE_JOB_DIR` set — headless runs drive `respond` themselves) disable it.

Two scoping rules keep it to work this session should actually do. Rounds already in the
inboxes when the hook first runs are retired by an install cursor (`.inbox-reader-since`
under the inbox base) — they were handled by whatever was watching before it, and
re-raising them would drive duplicate pushes and replies. That cursor is stamped behind
any scanner already running rather than at the moment it is written, because the first
Stop of a session can come after that session's rounds have already landed and those are
live work, not history.

Retiring is not the same as dropping. A pre-cursor round that carried findings is **named
once**, in its own section, with the command to re-scan that PR — some of those rounds
really were unclaimed, and the hook cannot tell which. Saying so once is the honest middle
between replaying them (duplicate pushes and replies) and discarding them in silence. The
notice is recorded per inbox in `sentinel-baselined` and never repeats. And when the Stop payload names
a `cwd`, only that repo's inboxes count. Note this scopes by **repo, not session**: a PR
of the repo you are in is fair game for any session working there, which is the whole
durability point, the same way `referee-owed-check.sh` behaves.

Discovery is per inbox **directory**, not per inbox file: the scanner takes its lock and
then sleeps `SENTINEL_AUTOSCAN_DELAY` (~330s) before writing anything, so keying on
`respond-inbox.jsonl` alone would miss every stop in that first window. For the same
reason the active head SHA comes from the newest `new_commit` line when one follows the
last scan — the scanner logs the commit switch and then sleeps again, and the previous
commit's spent wait budget must not starve the new one.

"Is the scanner alive" needs both halves: a fresh `.autoscan.lock/heartbeat` **and** a PID
that still exists. The scanner touches the heartbeat when it takes the lock and again every
window and every round. Neither signal is sufficient alone — a PID cannot answer it because
the lock outlives a crashed scanner and the OS recycles numbers, and a heartbeat cannot
answer it because a killed scanner leaves its last one behind. The same pair gates
`acquire_lock` in the scanner, so a recycled PID can never wedge a PR shut.

| Variable | Default | Purpose |
|---|---|---|
| `SENTINEL_STOP_MAX_REBLOCKS` | `3` | How many times an unchanged unacked round keeps holding a re-stop before the hook lets go. Releasing on the first re-stop would lose findings the agent simply ignored; never releasing would spin |
| `SENTINEL_STOP_MAX_WAITS` | derived | Max waiting blocks per head SHA before the hook lets the session go. Defaults to `SENTINEL_AUTOSCAN_MAX_ROUNDS + 2` (10 at the stock cadence) so it outlasts the scanner's own polling run for that commit — one wait before the first scan, then one per quiet round |
| `SENTINEL_HEARTBEAT_MAX_MIN` | derived | Minutes before an unrefreshed `.autoscan.lock/heartbeat` reads as a dead scanner. Defaults to `2 × max(DELAY, DEBOUNCE) + 120s` rounded up — 13 at the stock cadence — so retuning either knob moves it too |

Offline unit tests: `bash hooks/tests/test-sentinel-inbox-check.sh`.

## curator-reminder.sh / curator-md-nudge.sh / curator-stop-check.sh

The curator loop's three nudges (see `engine/curator/README.md` for curator itself):

Note: curator CLI commands talk to a server on 127.0.0.1, which sandboxed shells
(e.g. Claude Code's Bash sandbox) block — if a command reports the server "running but
unreachable", re-run it unsandboxed, and stop retrying after 3 consecutive poll failures.

- **curator-reminder.sh** — `ExitPlanMode` only fires on an *approved* plan; the hook
  injects `additionalContext` telling the agent to render the plan as a
  `.plans/<slug>.html` curator artifact and run the feedback loop before
  implementing. Non-blocking; degrades gracefully when curator is not installed.
- **curator-md-nudge.sh** — fires on `Write|Edit` of a large (>= 4 kB) markdown file
  that looks like a deliverable (skips READMEs, CLAUDE.md, memory files, `.plans/`);
  nudges toward a curator artifact instead. Self-disables without curator and in
  background jobs.
- **curator-stop-check.sh** — Stop-event safety net: if the turn produced a
  review-shaped deliverable but curator was never opened, it blocks the stop ONCE
  (`stop_hook_active` guard — it can never wedge a session) with instructions to
  finish the loop. Fails open on every edge case (missing transcript, format drift).

## eval-gate.sh — nudge to run the offline eval harness after an engine-relevant push

Advisory-only, nudge-never-blocks: after a `git push`/`gh pr create` whose merge-base
diff touches an eval-relevant path (`evals/config.yaml`'s suite `select:` globs), it
injects `additionalContext` telling the agent to run `engine eval --changed` and report
the verdict on the PR. Never runs eval itself and never affects CI's actual gate — that
enforcement lives entirely in `.github/workflows/eval.yml` (see
`engine/eval/README.md`'s "Gate promotion & burn-in" section).

Kill switches (checked first, before any side effect): `EVAL_GATE=off` (this hook's
master off-switch), `OWL_RUN` (any value — unattended/overnight loops), and
`CLAUDE_JOB_DIR` (any value — background jobs), the doctrine-required self-disable every
detent hook carries.

The nudge text is mode-aware (never authoritative — just tells the agent what CI will
actually do): `EVAL_BLOCKING` env wins if set (`on`/`off`), otherwise it sniffs the
committed `gate.mode` out of `evals/config.yaml` with a small `awk` (brittle to
reformatting, pinned by `hooks/tests/test-eval-gate.sh` — worst case the wording is
wrong, never a blocked push). Dedup is unchanged: one nudge ever per (repo, head-sha).
Offline unit tests: `bash hooks/tests/test-eval-gate.sh`.

## comment-discipline.sh — write short comments the first time, don't strip them at review

referee's deslop lens already flags gratuitous comments, but only *after* a diff
exists — by then the prose is written, reviewed and argued over. This hook moves the
same standard to authoring time, injecting the short form of the rule as
`additionalContext`.

**It fires on two events, because each covers the other's blind spot.**
`SessionStart` runs before any tool call, so it catches the common case a PostToolUse
hook structurally cannot: a session that creates a new file with its comments already
in it, in one `Write`, and never writes again. `SessionStart` does not fire for
subagents — and detent delegates much of its coding to FAST-tier subagents — so
`PostToolUse` on `Write|Edit` reaches those. Both share one dedup marker, so it is
exactly **one injection per agent**, whichever event gets there first (tests 11–13).

**Residual gap, stated plainly:** for a *subagent*, `PostToolUse` fires after the write,
so a subagent whose first write is also its only write authors those comments without
having seen the rule. There is no verified pre-write injection point to fix that —
`engine/curator-triggers/hooks.md` does not verify `PreToolUse`, and its one known-good
lever there is `permissionDecision`, i.e. blocking, which the hook doctrine forbids.
referee's deslop lens catches that case at review; the two layers exist because neither
is complete alone.

The standard (canonical text: `skills/deslop/SKILL.md`, slop category 1): comments are
minimal and concise, explain only a non-obvious *why*, never restate the code, and
never narrate the change itself. Where the *why* is genuinely external, a bare ticket
key (`// PROJ-2534`) replaces the paragraph — once per construct, never a per-hunk
marker. Documentation comments the language or repo convention requires on exported
symbols (godoc, Javadoc, JSDoc/TSDoc, docstrings, licence headers) are explicitly **not**
slop and are never stripped; doing so would break `revive`/`golint`/checkstyle.

**It does NOT self-disable under `CLAUDE_JOB_DIR` / `OWL_RUN` — deliberately, and
`hooks/tests/test-comment-discipline.sh` cases 7 and 8 pin that.** Every sibling hook
self-disables in unattended runs because each nudges the agent to *spawn work* (a
`/deslop` run, an eval sweep, a curator artifact) — token spend and objective drift in
a loop nobody is watching. This hook spawns nothing; it injects ~70 words, once. The
requirement is "every code change, universally", and headless/background/owl sessions
write plenty of code. The price of that exemption-from-the-exemption is that every
failure path (no `jq`, unreadable payload, unwritable marker dir) must exit 0 in
silence, which the tests also pin.

Kill switch: `COMMENT_DISCIPLINE=off`. Dedup: one injection **per agent** — an atomic
`mkdir` marker under `<detent-clone>/.local/comment-discipline/`, keyed on
`session_id` + the transcript file name. Not `session_id` alone: subagent payloads
carry the *parent's* session id, so that key would let the parent's `SessionStart`
claim the marker and starve every subagent (test 13 guards this). Unlike the push
hooks' (repo, head-sha) keys these never rotate, so markers are pruned by age — which
makes the precise guarantee *once per agent per 30-day retention window*, not "once,
ever": an agent still writing 30+ days on, or a session resumed after that long, gets
the rule again. That is ~70 words re-injected into a month-old session, which is the
cheaper side of the trade against a directory that grows forever. Offline unit tests:
`bash hooks/tests/test-comment-discipline.sh`.
