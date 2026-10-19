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

Reports about your own provider commands, your own `stack.yaml`, or a third-party bot or connector belong with their owners.

## Supported versions

Only the latest release on the default branch gets fixes.
