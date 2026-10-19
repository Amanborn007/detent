# Plugin-first: how detent installs and why the split exists

Detent installs in **two complementary halves**, not two redundant ones.

## The plugin owns (Claude-Code-facing)
- **Skills**: clerk, curator, owl, scout and the rest of the crew (loaded into every session).
- **Hooks**: every script listed in `hooks/hooks.json`, wired automatically using `${CLAUDE_PLUGIN_ROOT}`.
- **In-session executable calls**: skills invoke the bundled CLIs plugin-relatively.

Install: `claude plugin marketplace add Amanborn007/detent` then `claude plugin install detent@detent`.
The marketplace source may point at a **branch ref or a local directory**, so you can
install and try the plugin from a branch before it reaches `main`.

## The install script owns (shell-level, irreducible)
- **CLIs on PATH** for manual shell use (`curator`, `engine`, `sentinel`).
- **`DETENT_ROOT`** in the shell profile: lets run state (`.sdlc/`), `.plans/`, and team
  profiles resolve from any directory, so a multi-repo task has one home.
- **`detent.user.yaml`** seed.

A plugin manifest cannot put a binary on your PATH or export a shell variable. Those are
inherently shell-level, so some install step always remains. Everything else is the plugin's.

## The executable-invocation idiom (why it's written this way)
Skills invoke bundled executables as:

    node "${CLAUDE_PLUGIN_ROOT:-${DETENT_ROOT:-.}}/engine/curator/cli.mjs" ...

This is **defensive under every substitution behavior**:
- Installed as a plugin → `CLAUDE_PLUGIN_ROOT` resolves to the plugin dir.
- Plain clone with the install script run → falls back to `DETENT_ROOT`.
- Neither → falls back to the current directory.

It is not confirmed whether `${CLAUDE_PLUGIN_ROOT}` is exported into bash that a skill
runs, as opposed to hook commands. The `DETENT_ROOT` fallback makes the idiom work
either way, which is why it has two fallbacks. Hook commands use `${CLAUDE_PLUGIN_ROOT}`
as the Claude Code hooks documentation describes.
