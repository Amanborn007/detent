# Detent

[![test](https://github.com/Amanborn007/detent/actions/workflows/test.yml/badge.svg)](https://github.com/Amanborn007/detent/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-c8501a.svg)](https://code.claude.com/docs/en/plugins)
[![Version](https://img.shields.io/badge/version-0.11.0-informational.svg)](.claude-plugin/plugin.json)

**Ticket in. Draft PR out. Nothing ships without your yes.**

## The problem

A coding agent that works from a ticket can plan something the ticket did not ask for, review its own diff, and push. A team that lets agents open PRs needs two things. A human approves the plan before any code exists, and the review and the evidence come from something other than the author before anything is pushed.

One committed run shows both, on [detent-demo#1](https://github.com/Amanborn007/detent-demo/issues/1) ("Add a maxLength option to slugify"). It ended in [PR #2](https://github.com/Amanborn007/detent-demo/pull/2), merged 2026-10-21. The change is a toy one in a demo repo, so this shows the mechanism and nothing about how often it matters. The decisions are in [decisions.json](docs/examples/2026-10-20-amanborn007-detent-demo-1/decisions.json).

- **D-002.** The plan added a documentation step the ticket never asked for. The run asked instead of silently doing it. The answer was "keep step 4".
- **D-004 and D-005.** At ship there was no reviewer socket and no verifier socket. The only review was the agent's own pass, which "found no blocking issue", and the evidence was gathered by hand. The human refused both. The recorded reasons for rejecting them are "wanted a reviewer independent of the author" and "evidence from the author is not independent". Both sockets were wired.
- **D-007.** The wired `claude-reviewer`, a separate headless Claude call, found that an empty or alphanumeric separator lets the `maxLength` cut split words. The PR fixed it by rejecting a word-character separator when `maxLength` is set, with the failing test committed first.

## See it run

You need Node 20 and `git`. This runs the real engine from `detent setup` to the plan gate in a few seconds. It needs no install, no network and no LLM.

```sh
git clone https://github.com/Amanborn007/detent && cd detent
bash docs/demo/try.sh
```

```
✓ setup    wrote detent.user.yaml, stack.yaml
  still yours to fill: user.teams, user.jira_account
✓ run      2026-11-10-acme-widgets-1 created
  next stage: intake
✓ ticket   acme/widgets#1  "Retry delay drifts when Retry-After is 0"
✓ intake   done  (brief.md on disk)
✓ research done  (research.md, access-report.json on disk)
■ plan     written, held at the intent gate (D-001 pending)
■ gate     waiting on you: intent gate D-001 (approve or revise)
  page: $DETENT_ROOT/.plans/2026-11-10-acme-widgets-1-intent.html
```

A stub stands in for your tracker and canned files stand in for Claude's stage output. Every stage transition and gate comes from the engine. The script prints the gate page path and the scratch directory to delete.

<p align="center"><img alt="A terminal runs detent setup, then detent run new for a ticket, then the stages one line each, and stops at the plan gate with 'waiting on you: intent gate D-001 (approve or revise)' and the path of the gate page." src="docs/demo/demo.gif" width="720"></p>

The plan gate opens as a local page. You click **Approve the plan** or **Send it back**.

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/demo-gate-dark.png">
  <img alt="The plan gate page for the demo run: the question, approve and revise buttons, and the plan text under review." src="docs/assets/demo-gate.png" width="560">
</picture></p>

**A real run.** The committed run went through all 7 stages. Reviewer round 1 asked about the separator, round 2 flagged a JSDoc that over-promised, which the last PR commit fixed, and round 3 had no findings. The verifier passed, with `npm test` at 13 passed and 0 failed. `recheck.md` says "clean", and says itself that commit order is not proof the tests were seen failing. The commits go red then green: 9 at first ship evidence and 13 in the merged PR. `benchmark.json` is partial. It covers 3m34s of agent time up to the plan gate, and the rest of the run was human wait. Read the [run folder](docs/examples/2026-10-20-amanborn007-detent-demo-1/), the gate pages in its `plans/` folder (`*-plan.html`, `*-ship.html`), or [PR #2](https://github.com/Amanborn007/detent-demo/pull/2). Recorded terminal and Claude Code walkthroughs are listed in [docs/demo/README.md](docs/demo/README.md).

## Use it on your repo

You need Claude Code with plugins, Node 20, `git`, `bash`, `jq`, `python3` and a signed-in `gh`. In Claude Code:

```
/plugin marketplace add Amanborn007/detent
/plugin install detent@detent
```

Then, from a clone of this repo, run `scripts/detent-install.sh`. It runs `npm link` for `engine/curator` and `engine/cli`, which needs a writable npm global prefix. nvm works. With a system Node, set `NPM_CONFIG_PREFIX` to a directory you own first. It appends a `DETENT_ROOT` block and a `detent-upgrade` alias to `~/.zshrc`, `~/.bashrc` or `~/.profile` (chosen by `$SHELL`), or to the file named by `DETENT_PROFILE`. It copies `detent.user.example.yaml` to `detent.user.yaml` if that file is missing, and creates `.local/` in the clone.

Then, in a new shell:

```sh
detent doctor
cd ~/code/your-repo
detent start your-org/your-repo#123
detent continue     # one step
detent status       # stages, the gate waiting on you, the next step
detent decide       # open the waiting gate in curator
detent approve      # or answer the plan gate in this terminal
```

In Claude Code the same verbs are `/detent:start`, `/detent:continue` and `/detent:status`, and `continue` runs the stage in your session. `approve` and `revise` refuse inside Claude Code, inside a drive child and without a TTY (#24), so an agent cannot answer its own gate.

**What spends credit.** In a terminal, `detent continue` starts a headless Claude after you confirm a budget. The `claude-reviewer` adapter spends tokens on every call. `detent drive` runs intake, research and plan unattended, is experimental, and spends credit (default budget 5 USD per invocation). `try.sh` is offline and model-free.

## How it works

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/detent-pipeline-dark.png">
  <img alt="Detent stage pipeline: intake, research, plan, implement, recheck, ship and respond, with your approval required at the plan gate and the ship gate, and the respond loop driven by sentinel scans." src="docs/assets/detent-pipeline.png" width="880">
</picture></p>

| Stage | What Detent does |
|---|---|
| intake | Writes `brief.md`. Each unknown becomes a decision you answer. |
| research | Asks every knowledge source you plugged in, and names any it could not reach. |
| plan | Writes the plan with a verify command per step, then waits at the plan gate. |
| implement | Commits red then green in a separate worktree. Never touches your checkout. |
| recheck | Compares the diff with the approved plan. Drift goes back to you. |
| ship | Runs your reviewer and verifier, shows the evidence, waits for your yes, then opens a draft PR. |
| respond | After you mark the PR ready, fixes the bot comments your policy allows and passes the rest to you. |

The CLI enforces the plan intent gate in code, where you click **Approve the plan** or **Send it back** ([GUIDE.md](GUIDE.md#3-the-stages-and-gates)). The drift and ship gates are rules in the stage prompts, recorded as pending decisions that block the stages they name. Nothing in the code calls `gh pr merge`.

Your tracker, docs search, reviewer and test runner plug in as sockets. A socket is a command: the engine writes one JSON request to its stdin and reads one JSON response from its stdout. Exit 0 is ok, exit 1 is retried once and then shown to you, and exit 2 halts the stage and asks. Six adapters ship in `engine/adapters/`. See [GUIDE.md section 5](GUIDE.md#5-sockets-and-providers) and [section 6](GUIDE.md#6-writing-a-provider-and-a-pack).

The plugin has 14 skills, typed as `/detent:<skill>`. `start`, `continue`, `status` and `drive` run the stages. The other ten are `referee`, `deslop`, `clerk`, `scout`, `examiner`, `curator`, `owl`, `herald`, `scribe` and `courier`, and the [reference](docs/REFERENCE.md#skills) lists what each reads and writes. Try `/detent:deslop` first. It needs no config, reads your own diff, and changes nothing until you say yes.

## Testing

```sh
node --test --test-timeout=300000 engine/*/test engine/*/tests
bash engine/owl/test/run-tests.sh
for f in hooks/tests/*.sh scripts/tests/*.sh engine/scripts/tests/*.sh; do bash "$f"; done
```

The suite binds `127.0.0.1` and writes to `/tmp`, so it fails inside a locked-down sandbox. [CI run 42786785915](https://github.com/Amanborn007/detent/actions/runs/42786785915) on main at 0731283, 2026-11-10, passed on ubuntu and macOS with 2089 tests, 2065 pass, 0 fail, 24 skipped, and owl 88 pass, 0 fail. The node suite took 122 s on ubuntu and 203 s on macOS.

Some of the edge cases it covers:

- `engine/cli/tests/drive-claude-tmp.test.mjs`: the 44-byte bound on the claude tmp path is exact, so 44 passes and 45 fails with a clear error.
- `engine/cli/tests/drive-egress.test.mjs`: a DNS answer in a loopback, RFC1918, link-local, metadata or v4-mapped range is refused, and the proxy dials nothing.
- `engine/cli/tests/drive-preflight.test.mjs`: a secret-looking env name such as `ADMIN_PASSWORD` refuses, and the value never appears in the output.
- `engine/curator/test/auth.test.mjs`: a foreign `Host` is refused, an unauthenticated request with a bad JSON body gets 401, and `OPTIONS` gets 405.
- `engine/owl/test/run-tests.sh`: reset on failure, a no-op counts as failure, the three-failure kill switch, and the iteration cap.

Failing tests are committed before the fix. When a committed test has to change, the commit says so, for example 8f7d47a ("user-approved frozen-test change"). Not in CI: the `docs/demo` tests and `smoke.sh`, and the adapter smoke tests, which call the live GitHub API. Owl is tested only against a stub `claude`.

## Known limitations

- Only the plan gate is enforced in code. The drift and ship gates are prompt rules plus blocking decisions.
- After a PR is marked ready, `respond` and the `sentinel-inbox-check` Stop hook push fixes without per-item approval, for up to 10 rounds. [What runs without asking you](docs/REFERENCE.md#what-runs-without-asking-you) lists every such part and its kill switch.
- Drive is experimental and spends credit. `--restricted` is not an OS sandbox, and `--budget` can overshoot by one turn.
- `drive --implement` is on main via #41, macOS only, and its live end-to-end run is unverified.
- Curator auth does not protect against another process running as you. See [SECURITY.md](SECURITY.md).
- In the example, `respond` converged only because the demo repo has no review bots.
- The tree-sitter tagger in `engine/index` is untested. The regex tagger is what runs (#22).

## Read more

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md), [CHANGELOG.md](CHANGELOG.md), [GUIDE.md](GUIDE.md), [docs/REFERENCE.md](docs/REFERENCE.md), [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Inspired by Kun Chen's MIT-licensed no-mistakes, lavish-axi and gnhf. No code was copied, see [NOTICE](engine/NOTICE.md). Licensed under [Apache 2.0](LICENSE).
