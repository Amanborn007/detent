# Sandbox probes for `detent drive` implement

These probes decide the sandbox design for the Bash stages. Each probe prints a JSON record
`{probe, expected, actual, pass, status}`. `status` is `pass`, `fail`, `inconclusive` (the unsandboxed
control failed, so the result proves nothing) or `skipped` (nothing to test on this host).

## Run

From an **unsandboxed terminal** on macOS (`sandbox-exec` fails with exit 71 when nested, and the
harness stops with `sandbox_unavailable:nested`):

```
node engine/cli/drive/probes/run-probes.mjs            # sandbox probes only, no spend
node engine/cli/drive/probes/run-probes.mjs --live     # adds PB2-PB6 and the claude-sandbox alternative
```

Options: `--out <file>` also writes the report, `--keep` keeps the temp dir. The exit code is 0 when no
probe has status `fail`, 1 otherwise, 71 when nested and 2 for other setup errors.

`--live` spends at most 0.10 USD on `claude-haiku-5-5` (three runs, each capped by `--max-budget-usd`).
The outer-sandbox runs need `ANTHROPIC_API_KEY` in the environment and are skipped without it. The
alternative run uses your normal `claude` login.

## What it checks

- `PB1.*` SBPL last-matching-rule-wins: deny inside an allowed tree, allow inside a denied tree, and
  a write deny after a write allow.
- `esc.*` escapes: firmlink and `/.vol/<dev>/<ino>` reads of denied files, hardlink into scratch, a copied
  `launchctl submit`, `defaults write`, a copied `open`, `mdfind`, `security find-generic-password`,
  unix sockets (a harness socket plus `/var/run/*.sock` and `~/.docker/run/*.sock`), `ps -E` and
  `KERN_PROCARGS2` on the harness (which carries a random `PROBE_CANARY`), `kill -0` on the harness,
  and a write open of a `/dev/ttys*`.
- `read.*` and `write.*` denied directories (counts only) and writes outside scratch.
- `net.*` an external host must fail, the one loopback port must work, another loopback port must fail.
- `toolchain.*` node, npm, git (plus init and commit in scratch), go, cargo, python3, make, clang.
  Expected is measured unsandboxed first, so a tool missing on the host is `absent`, not a failure.
- `live.pb2` to `live.pb6` and `live.outer.*`: claude behind a plain-http proxy with a fake HOME, Bash
  under the outer sandbox, binary readable with `/Users` otherwise denied, managed settings detection,
  and the isolation checks run from inside Claude's Bash tool.
- `live.alt_builtin.*`: an unsandboxed `claude -p` using its own sandbox
  (`enabled`, `failIfUnavailable`, no unsandboxed commands) and OAuth. It checks `~/.ssh/config`, the
  `~/.claude` credentials, the `Claude Code-credentials` keychain item, the parent's environment,
  external network, `kill -0` and `/dev/ttys*`.

Only exit codes, booleans and counts are recorded. Marker files are created in a temp directory and that
directory is added to the profile's read denies. The real `~/.ssh` is only listed, never read, and
nothing is written under it. The `--live` alternative run reads `~/.ssh/config` and the keychain item
from inside Claude's Bash tool with output sent to `/dev/null`.

## Profile

`seatbelt-deny-default.mjs` generates the profile from Claude Code 2.1.306's own Seatbelt template,
without the `com.apple.securityd.xpc`, `com.apple.coreservices.launchservicesd` and
`com.apple.SecurityServer` mach names. It is unit tested in `engine/cli/tests/drive-probes.test.mjs`,
but the profile has not been applied by `sandbox-exec` yet; the first run on a real terminal is the check
that it compiles.

## Diagnosing a blocked tool

`node engine/cli/drive/probes/run-probes.mjs --diagnose <tool>` runs one tool under the profile and prints the
sandbox denials from `log show` (process, operation, path, count; never tool output). `<tool>` is one of
node, npm, git, go, cargo, python3, make, clang or git-commit. If `log show` is refused, run it with sudo.

## Known limit

If `esc.procargs2_parent` still reports `visible` with the explicit `kern.procargs` deny in place, Seatbelt
cannot hide another process's environment, and the design must never put a secret in a parent's exec-time env or argv.
