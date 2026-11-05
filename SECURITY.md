# Security policy

## Reporting a vulnerability

Report it privately through GitHub security advisories. Open the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem. Please do not open a public issue or pull request for it.

Include what you can:

- The affected file, hook, skill or command.
- The version or commit you tested.
- Steps to reproduce, or a proof of concept.
- What an attacker gains from it.

The maintainers read reports as time allows. This is a volunteer project, so there is no response or fix time commitment.

## What counts

Detent runs shell hooks, spawns `gh` and `claude`, serves a local web page, and reads text from tickets, pull requests and chat threads. Reports about these are in scope:

- A hook or script that runs attacker-controlled text as a command.
- A skill or tool that follows instructions found in ticket, PR, bot or thread text.
- The curator server accepting a request without its secret or a session key, from a `Host` other than its own loopback address and port, or from a foreign `Origin`, or serving files outside its artifact directory.
- Owl running with wider permissions than its scoped profile, or any use of a permission-bypass flag.
- Secrets or private content written to a place that is committed or sent off the machine.
- A gate that can be skipped, so a push, a ticket creation or a reply happens without approval.
- A `detent drive` child that runs a command, reaches the network, writes outside its outbox or changes run state.

Reports about your own provider commands, your own `stack.yaml`, or a third-party bot or connector belong with their owners.

## The contained `detent drive`

`detent drive` is experimental and spends Claude credit. By default it covers slice A only: intake, research and plan, then it stops at `before_implement`. With `--implement` it also runs the implement step, described in the next section. It never ships, and it refuses `--allow-ship`. Without `--implement` it runs on macOS and Linux.

What is contained:

- Each stage is one `claude -p --restricted` child with `--tools Read,Glob,Grep,Write,Edit,TodoWrite`. There is no Bash, no MCP, no web access, no hooks and no subagents. `--restricted` ignores user, project and local settings files and confines the file tools to the child's two working directories.
- The child reads a read-only `inputs/` directory and writes only an `outbox/`, both under `$TMPDIR/detent-drive/`, outside the detent clone. Its working directory is an empty read-only directory. The repo it sees is a `git archive HEAD` export with no `.git`.
- The environment is an allowlist. Tokens, cloud credentials and `SSH_AUTH_SOCK` are not passed. The real `HOME` is passed, because OAuth needs it.
- The child never touches the engine, curator or run state. Drive alone writes `stage-status.json`, `decisions.json`, `run.json`, `env.json` and the gate pages, after validating the outbox manifest, its sha256 digests and a secret scan. A digest of the run directory, the gate pages, the fixed `stack.yaml` and the engine files is checked after every child, and a change fails the step as `state_tampered`.
- Curator answers are collected once, before any child starts. Drive renders each gate page from escaped text.

What is not covered:

- The file tools are confined by `--restricted` and permission rules inside the claude process. There is no operating-system sandbox around them, so a bug in claude's own confinement is a bug here.
- Managed (organisation) settings and hooks still load under `--restricted`.
- A prompt-injected child can still shape the text of a plan or a decision question. Read the gate page as you would a pull request.
- Curator authentication stops web pages and other users, not a process of yours that can read `secret` (see below). Such a process can also edit `decisions.json` directly, so curator is not a barrier against it.
- `--budget` is enforced by claude and can overshoot by one turn. The secret scan is a tripwire for common key shapes, not a control.
- Nothing watches the run directory between invocations; the integrity check runs while a drive is running.
- Without `--implement`, code from the repo runs only when you run implement, tests or ship yourself, interactively.

## `detent drive --implement`

`detent drive --run <id> --implement` is experimental, macOS only and OAuth only. Nothing is persisted: you pass the flag on every invocation, and without it drive stops at `before_implement` as before. On Linux it refuses with `implement_platform_unsupported`. A Linux host box exists (bubblewrap, no network), but the self-probe that vouches for the implement child only runs on macOS, and setup commands with network egress are not built on Linux. It also refuses when `ANTHROPIC_API_KEY` is set (`implement_api_key_refused`), because a key in the environment could reach the sandboxed child. It never ships and still refuses `--allow-ship`. Shipping is a step you run yourself.

How the implement child is contained:

- **Command and sandbox.** The child is `claude -p --restricted --tools Bash` under Claude Code's own Bash sandbox (Seatbelt on macOS). Drive writes the settings: your home directory is unreadable, the network is closed, writes go only to the clone, the outbox, a tmp dir and the shim call log, the `.git` files that redirect git (`config`, `hooks`, `commondir`, `worktrees`, `objects/info/alternates` and similar) are not writable, and your per-user tmp dir and claude's per-uid tmp are unreadable. The clone is a throwaway copy of the run's branch.
- **A shim shell.** Drive sets `CLAUDE_CODE_SHELL` to a shim. Claude runs every Bash command as `<shell> -c <command>` inside the sandbox, so the shim runs inside it too. Before each command it checks that it really is sandboxed, runs a probe script (reads of the denied directories, a write outside the allowed ones, a connection to a canary listener on localhost, and a few more), appends a line to the call log, and only then starts the real shell. If the probe fails, the shim prints a refusal and the command does not run.
- **Checks after the child exits.** The transcript is the ground truth, because the unsandboxed claude process writes it and the child cannot. Drive reads it and fails the step as `sandbox_probe_failed` if any tool use is not Bash, any Bash call carries `dangerouslyDisableSandbox` or `run_in_background`, or an input has a key other than `command`, `description` and `timeout`. It then matches the shim's log lines one to one against the Bash calls in the transcript: the count must be equal, each logged hash must match the logged command, and each logged command must match the transcript's command. Claude runs each Bash tool call as `<shell> -c '... && eval '<command>' < /dev/null && pwd -P >| <file>'`, with every `'` in the command written as `'"'"'`. When the logged string has that `eval '...'` wrapper, drive extracts the quoted part, undoes the `'"'"'` quoting and requires it to equal the transcript's command exactly. A string without the wrapper only has to contain the command, at word boundaries, so `ls` is not found inside `else`. Claude also makes two setup calls before the first command, `-c env` and a `-c -l` snapshot script. The shim logs those as setup lines, not as calls. Drive accepts each kind once and only before the first call, and counts neither against the transcript. It also requires a sentinel file, which the shim appends to only when it finds itself outside the sandbox, to exist and be empty.
- **What happens to the commits.** Only after those checks pass does drive export the child's commits as a git bundle in a host box, run `verifyBundle` on it, check the tree out with a hardened checkout (plain blobs only, no filters, symlinks or submodules), and run the verify command in a fresh host box with no network. The verify command comes from `commands.verify` in `env.json`, which a human sets with `engine env --run <id> --verify "<command>"`. A command a child proposed in `env.proposed.json` is never used. The commits are then imported into `detent/<run>`. A read-only child with only Read, Glob and Grep then compares the diff with the plan.
- **What blocks ship.** Drive raises a `recheck-review` decision every time, and a `sensitive-paths` decision when the diff touches files that run code or change tooling, such as CI config, git hooks, build scripts, `.env` files, agent config, lockfiles, or `package.json` outside a short list of harmless keys. Both block ship until you answer them. Read `recheck.md` and the diff before you do.
- **The host box.** Drive runs its own commands against the untrusted clone (bundle export, the verify command) in a deny-default Seatbelt profile. Your home directory, your user tmp dir and claude's per-uid tmp are unreadable, writes go only to the listed directories, `setsid` and `setpgid` are denied, the box is single-use (a second run in it is refused as `hostbox_box_reused`), and captured output is capped at 1 MiB. It never falls back to running unboxed.
- **Setup commands are not supported** in this version. A run whose `env.json` has `commands.setup` stops as `setup_unsupported`.
- **Managed settings.** A managed-settings hook still fires even when drive passes `--setting-sources ""`, and hooks run outside the sandbox. So `--implement` refuses to start when managed settings (or managed MCP servers) define `hooks`, `env`, a `sandbox` key, MCP servers, or keys outside a short allowlist. The step then stops as `implement_preflight_failed`.

What is not covered. Read these before you use it on anything you care about.

- **The claude process is not sandboxed.** Only the Bash commands are. The claude process itself, any hooks it runs and the git commands claude runs for itself run unsandboxed as you. Drive disables hooks in its own settings and refuses managed hooks, but the process boundary is claude's, not drive's.
- **Commit content is an exfiltration channel.** The child can read the clone, the plan and the other inputs, and anything it commits leaves the sandbox in the bundle. No secret scan of the diff exists: drive does not scan the implement commits for secrets. Review the diff before you ship, and treat anything in the clone or the inputs as something the child could write into a commit.
- **The shim log can be forged ahead of time.** The call log is writable by the child, because the shim has to append to it from inside the sandbox. The one-to-one check catches a command that skipped the shim or a log that drifted from the transcript. It does not catch a model that deliberately writes log lines for its own future commands before it runs them. The sentinel and the transcript shape checks do not cover that either.
- **Other processes' arguments and environment are readable on macOS.** A sandboxed command can read the exec-time argv and environment of other processes you run, through the `KERN_PROCARGS2` sysctl. This is the known gap in the self-probe, which reports it as a known limit and not as a failure. The mitigation is that drive refuses to start when its own environment holds a secret-shaped variable (`env_secret`), but a process another program started with a secret in its arguments is not covered. The host box denies this sysctl, but the implement child's profile is Claude Code's, not drive's.
- **The live end-to-end run is unverified.** The orchestration is tested with a stub claude. The containment is evidenced by the self-probe live tests and the host box live tests on macOS, not by a full implement run against a real model. Treat a first run as a test.
- **Commits are authored with your own git identity.** Drive reads `user.name` and `user.email` on the host, from the source repo's config first, then `~/.gitconfig` and the XDG config. It guesses nothing: if HOME is unset or holds neither value, the step stops as `git_identity_missing`, and a value with `<`, `>` or a newline stops it as `git_identity_invalid`. Bundle verification rejects any commit whose author or committer email is not yours as `foreign_author`. That surfaces as the stop `bundle_rejected`, and the code and detail are in `drive-last.json`.

## Curator access control

The curator server listens on `127.0.0.1` on a random port. It refuses every request that does not carry a credential, and it checks the request before it reads the body.

- **Secret.** The server creates `secret` (32 random bytes as hex, mode 0600) in its state directory on first start and keeps it across restarts. The state directory is `.local/curator` in the detent clone, or `CURATOR_STATE_DIR`. It must be owned by you, not a symlink and not writable by group or others, and so must every parent directory up to your home directory or the clone. The server and the CLI refuse to start on one that is, and they tighten a directory that is only readable by others to 0700. The secret file must be a regular file you own with mode 0600, or the server refuses to start. Nothing replaces a bad secret for you. The state files are written 0600. A state directory inside a git work tree gets a `.gitignore` containing `*`.
- **The CLI proves the server before it trusts it.** `curator` sends a fresh nonce to `GET /healthz` and only talks to a server whose answer is the HMAC of that nonce under the secret. A server that does not answer with a proof (an old curator, or another program on that port) receives nothing and its answers are refused. `curator open` replaces an old curator daemon after it checks that the recorded pid really is `server.mjs --daemon`, and refuses to stop any other process. If the secret is missing while a server runs, the CLI stops and tells you to stop the server first.
- **Agent routes** (`open`, `poll`, `reply`, `status`, `end`) take a file path and `Authorization: Bearer <secret>`.
- **Browser routes** (the page's own `send`, `end` and `updates` calls) take a session id and a per-session key, `HMAC(secret, "curator-session:" + id)`, in the `X-Curator-Cap` header. A cross-site page cannot send that header without a preflight, and the server answers no preflight. The key travels in the page URL's fragment (`#c=...`), which the browser never sends to the server or in a `Referer`.
- **Keys die with the server.** Both keys include a random id the server makes at each start, so a restart invalidates every open tab and a tab can not hand its key to whatever later takes the same port. The page removes the keys from the address bar once read, and the browser is launched on a local redirect file so the keys are never in a process argument list.
- **The artifact key** is a second HMAC (`curator-artifact:`), in the `?k=` of the iframe's `src`. It can read the artifact and nothing else, so a hostile artifact that reads its own URL gets nothing it can answer a gate with. The server refuses it on every other route.
- **Host and Origin.** `Host` must be present and exactly `127.0.0.1`, `localhost` or `[::1]` with the server's own port. A request with an `Origin` must come from that same origin, which rejects `null` and other ports. Every POST must be `application/json`. `OPTIONS` is refused.
- **Pages** are sent with `Referrer-Policy: no-referrer` and `frame-ancestors 'self'`.
- **`/api/open`** registers `.html` files only.

What this does not cover. A process running as you outside a sandbox can read `secret`, and can edit `decisions.json` and the artifacts directly, so it needs no key to change a gate. Curator authentication separates you from web pages, from other users on the machine, and from processes whose sandbox denies the state directory. It does not separate you from your own unsandboxed shell. A curator URL contains its keys: do not paste it into a ticket or a pull request. A browser extension or malware in the browser can read it. To rotate the secret, stop the server, delete `secret` and run `curator open`. Open pages need reopening afterwards.

The `detent drive` child gets deny rules for the state directory as well, although it has no tool that can reach the network or run a program.

## Supported versions

Only the latest release on the default branch gets fixes.
