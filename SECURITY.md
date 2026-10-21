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

`detent drive` is experimental and covers slice A only: intake, research and plan. It never implements, rechecks or ships, and it refuses `--allow-ship`. It runs on macOS and Linux and spends Claude credit.

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
- Code from the repo runs only when you run implement, tests or ship yourself, interactively.

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
