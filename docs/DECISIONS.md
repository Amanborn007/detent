# Decisions

Entries cite the PR or file that records the reason. An "Alternative" line says what the other design would cost in this code. I read that cost from the code. It is not taken from a discussion held at the time.

## 1. Run state is plain files under `.sdlc/`

- **Decision.** A run is a directory of files under `$DETENT_ROOT/.sdlc/<run-id>/`. There is no database and no server.
- **Why.** You can `ls` and `cat` a run at any point, and stages talk only through these files (`engine/stages/CONTRACT.md`). `events.jsonl` is an addition that can be deleted without breaking anything (D1 in `engine/cli/README.md`). A run needs no server to be running to be read. The directory lives in the detent clone, not the work repo. `engine/stages/CONTRACT.md` says tasks routinely span several repos, and a run can list several in `repos[]`.
- **Alternative.** A database or a daemon holding run state. Reading a run would then need that process up, and `decisions.json` would stop being a file you can open and edit in a terminal. Files give up queries and locking.
- **Cost accepted.** Any process of yours can edit `decisions.json` (SECURITY.md).
- **Evidence.** [GUIDE.md](../GUIDE.md#1-the-model-in-one-page), [docs/examples/](examples/).

## 2. Tools are JSON-over-stdio commands called sockets

- **Decision.** The engine runs a command, writes one JSON request to its stdin and reads one JSON response from its stdout. Exit 0 is success. Exit 1 is a provider failure, retried once and then shown to you. Exit 2 halts the stage and asks.
- **Why.** `exec` is the only socket kind the CLI can run itself. The `skill` and `mcp_tool` kinds only print an instruction block for the invoking agent (D8 in `engine/cli/README.md`). #10 changed one case: an exit 1 that carries a JSON body is kept as the response and not retried, because a verifier's `verdict: fail` needs it.
- **Alternative.** MCP tools, or in-process modules. In this code, a provider that is any executable means the six built-in adapters are zero-dependency scripts and a test can stub a socket with a few lines of shell. An MCP tool needs the agent to make the call, so the engine could not run it in a test or in `drive`. An in-process module would tie every provider to Node and to this repo.
- **Cost accepted.** The CLI does not enforce the `version` field of a provider yet (`engine/README.md`). A provider written against an older contract version runs without a warning until it returns a shape the engine rejects.
- **Evidence.** `engine/README.md`, `engine/sockets/*.md`, the comment above the retry in `engine/cli/engine.mjs`.

## 3. Gates are decisions answered by a human, and only the plan gate is enforced in code

- **Decision.** A gate is a question in `decisions.json`, rendered in curator. The engine never answers one. `detent stage end` refuses to finish the plan stage while the `intent` gate is pending. The drift and ship gates are rules in the stage prompts, recorded as pending decisions that block the stages they name.
- **Why.** `stage end` refuses while any decision that blocks that stage is pending (`engine/cli/tests/gates.test.mjs`). The engine raises the plan gate itself, and D-003 in the example run is `raised_by: engine`. The agent files the ship and drift decisions from the stage prompt. The push happens inside the ship stage, before `stage end`, so only the prompt keeps it behind the ship decision. That is the tradeoff: the ship gate costs no CLI code, and nothing but the prompt stops a push that skipped it. Moving the push into the CLI is listed under What I would change next.
- **Guards on the answer side.** A drive child cannot answer a gate. The outbox validator refuses `answer`, `status` and `answered_*` keys on child decisions, and the integrity digest fails the step as `state_tampered` (#17). #24 makes `approve` and `revise` refuse when `CLAUDECODE` is set, when `DETENT_DRIVE_CHILD=1`, or without a TTY. These read environment variables, so they stop an agent that calls the verbs as given. An agent that unsets `CLAUDECODE` and sets `DETENT_FORCE_TTY=1` gets past them. An intake, research or plan drive child has no Bash and cannot try. The `--implement` child has Bash under Claude Code's sandbox and does not get `DETENT_DRIVE_CHILD`.
- **Alternative.** A push made by the CLI behind the ship decision, listed under What I would change next. It needs `git push` and PR creation moved out of the ship prompt into a verb that refuses until the decision is answered.
- **Cost accepted.** For the ship and drift gates the code relies on the stage prompt to file the decision. In the example run, `decisions.json` shows D-004 and D-005 raised by `ship`.
- **Evidence.** [GUIDE.md](../GUIDE.md#3-the-stages-and-gates), `engine/cli/tests/verbs-approve.test.mjs`, `engine/cli/tests/drive.test.mjs`.

## 4. A plugin first, plus a shell-level install

- **Decision.** The plugin carries skills and hooks. `scripts/detent-install.sh` does the rest.
- **Why.** `docs/plugin-first-notes.md` says "A plugin manifest cannot put a binary on your PATH or export a shell variable". Skills fall back to `DETENT_ROOT` because it is unconfirmed whether `CLAUDE_PLUGIN_ROOT` reaches the bash a skill runs.
- **Alternative.** A plugin alone has no `detent` binary on `PATH`. An npm package alone delivers no skills or hooks.
- **Cost accepted.** A two-step install, and the second step appends a block to your shell profile.
- **Evidence.** `docs/plugin-first-notes.md`, `scripts/detent-install.sh`.

## 5. Drive children get a fixed tool list, not a permission profile

- **Decision.** Each intake, research and plan step is one `claude -p --restricted` child with `Read`, `Glob`, `Grep`, `Write`, `Edit` and `TodoWrite`. No Bash. It starts in a read-only empty directory, reads an export of HEAD read blob by blob with `git ls-tree` and `git cat-file`, with no `.git`, no symlinks or submodules and no gitattributes applied (`exportRepo` in `engine/cli/drive/drive.mjs`), and writes only an outbox that drive validates and secret-scans. A digest of run state is checked after every child (#17). The `--implement` child is the exception: `claude -p --restricted --tools Bash` under Claude Code's sandbox, with a shim shell and post-run transcript checks (#41, SECURITY.md).
- **Rejected.** #8 gave children a settings profile, a Bash allowlist and a push-URL rewrite. Its own "Not covered" line said a child's test command could still run arbitrary repo code and reach the network. #17 replaced it.
- **Why.** #8's residual risk was a child that could run a command. #17 gives an intake, research or plan child no Bash, MCP, web, hooks or subagents to run one with.
- **Related rule.** `run new` copies the index's suggested command into `env.json` as `suggested.verify` and never writes `commands.verify` (#22). A drive child cannot set `commands.verify`, because its proposal in `env.proposed.json` is never used. In an interactive run the implement stage records it with `detent env --verify`. `drive --implement` runs it on the host in a no-network box (#41).
- **Cost accepted.** `--restricted` is not an operating-system sandbox, `--budget` can overshoot by one turn, and a prompt-injected child can still shape gate text. SECURITY.md lists the rest.
- **Evidence.** `engine/cli/tests/drive-surface.test.mjs` asserts the old permission model's markers are gone from `engine.mjs`.

## 6. Curator requires authentication, and gates use only the bundled curator

- **Decision.** The server creates a mode 0600 secret. The CLI checks an HMAC proof from the server before it sends the secret. Browser routes take a per-session key. `Host` and `Origin` are checked before the body is read. Gates run the curator CLI in this repo, never one found on `PATH` (#21).
- **Why.** Before #21 a web page could post a gate answer with a `no-cors` `text/plain` request, and the next `detent drive` would collect it as a human answer.
- **Alternative.** Loopback with no auth, which is what #21 replaced.
- **Cost accepted.** A process of yours that can read the secret can still answer a gate (SECURITY.md). A curator on `PATH` no longer reaches gates (948e9e5).
- **Evidence.** `engine/curator/test/auth.test.mjs`. The 34 tests #21 added to `engine/curator/test/auth.test.mjs` were committed first, and 33 of them failed on main. The file now has 33 `test()` calls.

## 7. Headless model calls go through a runtime port

- **Decision.** The reviewer and the eval judge call `engine/runtime/`, not `claude -p` directly. A request a runtime cannot honour is refused before anything runs (#27). `openai-compatible` is the second adapter (#32).
- **Deferred.** Owl still calls `claude` from bash. A node process between owl and claude would let owl's timeout orphan `claude`, which could keep editing the repo after owl's rollback. Drive did not move either, because its containment is more than flags. #27 says both are "Not moved yet" and leaves them for phase 2.
- **Why.** #27 gives the reason for the port: so the headless agent calls stop being hardwired to `claude -p`, as phase 1 toward other coding agents. That is what let `openai-compatible` be a second adapter (#32). The port stays synchronous because the judge reads scores synchronously all the way down, so an async port would have broken it (#32).
- **Cost accepted.** Owl and drive keep their own `claude` calls until the follow-ups to #34 land. #34 is open and extends the port with the fields they need.
- **Evidence.** `engine/runtime/CONTRACT.md`, `engine/runtime/conformance.mjs`.

## What did not work

- **The first end-to-end run (#10).** It ran on Amanborn007/detent-demo#1, installed the way the README said. `next_step` named an `engine` command that is not on `PATH`. The stage prompts described `fetch:` and `query:` sockets that no adapter implements. Plan filed its own approval on top of the intent gate. Run state went into the user's main checkout. Stage docs said `review` and `pr` where the CLI has only `ship`, so recheck drift never blocked ship. Recheck diffed a commit range that implement never recorded, so `run new` now records `base_sha`. Each fix landed with a failing test first.
- **Stacked PRs that never reached main.** #11 and #13 were squash-merged into their stacked base branches, so their content never reached main. #14 landed them again. #37 and #38 did the same, and #40 landed them.
- **The first drive permission model.** #8 was merged and replaced by #17 within the hour (decision 5).
- **An open curator.** Before #21 any web page could answer a gate (decision 6).
- **Tests that opened real browser tabs.** Gate-reaching tests ran `curator open`, and the test environment never set `CURATOR_NO_BROWSER`, so tests opened tabs and left daemons running. The #35 body says 149 leaked in one session. The fix is a `NODE_TEST_CONTEXT` tripwire in the curator CLI, a per-test `CURATOR_STATE_DIR`, a `curator stop` verb and `after()` hooks.
- **Curator answers lost three ways (#39).** A note with no pick was stamped as the string "null" and dropped. `gate collect` dropped answers it could not resolve. Every re-render of a gate page wiped the curator stamps. #39 fixed all three.
- **A hung curator test (#43).** The `reply ... blocks until end` e2e test hung for more than 12 minutes under full-suite load, per the PR body. CI now runs `node --test` with `--test-timeout=300000`. The PR names a lost wake-up as the likely cause. It is not fixed yet.

## What I would change next

- Fix the lost wake-up behind #43.
- Merge PR #51, which makes curator's ancestor check (`checkAncestors` in `engine/curator/auth.mjs`) skip parents that do not exist yet. Until it merges, `curator open` fails with ENOENT on `<clone>/.local` on a fresh clone, with `DETENT_ROOT` unset or set to the clone, which is what the install script sets. Running `mkdir .local` in the clone first avoids it.
- Move the ship push into the CLI behind the ship decision, so the code and not only the prompt refuses a push without it (decision 3).
- Run `drive --implement` live, end to end. That run is unverified (#41).
- Add a secret scan of implement commits, which SECURITY.md lists as not covered.
- Have `detent setup` write a `reviewer` and a `verifier`, or have `detent doctor` fail without them. Today the starter `stack.yaml` has neither.
- Remove the duplicate `drive` line from `detent --help`.
- Run the `docs/demo` tests and `smoke.sh` in CI. `docs/demo/terminal-smoke.sh` now finishes offline.
- Split `engine/cli/engine.mjs`, 3337 lines at 464e527, into modules along its existing section comments: run and stage, gates, sockets, and the friendly verbs.
- Fix `cmdDecide`, which reports only the last 300 characters of a curator failure, so the start of a long error is dropped. `detent decide` also has no option to skip the wait in `curator poll`, which is why the demo scripts do not call it.
