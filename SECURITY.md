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
- The curator server accepting requests it should refuse, such as a non-local `Host` header, or serving files outside its artifact directory.
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
- The curator server accepts requests from any process of your user on this machine, so another local process can post an answer to a gate. Drive does not authenticate curator.
- `--budget` is enforced by claude and can overshoot by one turn. The secret scan is a tripwire for common key shapes, not a control.
- Nothing watches the run directory between invocations; the integrity check runs while a drive is running.
- Code from the repo runs only when you run implement, tests or ship yourself, interactively.

## Supported versions

Only the latest release on the default branch gets fixes.
