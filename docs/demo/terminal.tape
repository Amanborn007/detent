# Render from the repo root:  vhs docs/demo/terminal.tape   (the same commands run in CI: bash docs/demo/terminal-smoke.sh)
# Offline: stub claude, gh, curator and ticket socket. The detent engine is real.
Output docs/demo/terminal.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

Hide
Type "source docs/demo/terminal-env.sh" Enter
Type "clear" Enter
Sleep 2s
Show

Type "# stack.yaml is missing on purpose: detent start writes it" Enter
Type "detent doctor" Enter
Sleep 3s
Type "clear" Enter
Type "detent start acme/widgets#1" Enter
Sleep 4s
Type "detent status" Enter
Sleep 3s
Type "clear" Enter
Type "detent continue" Enter
Sleep 1s
Type "y" Enter
Sleep 3s
Type "detent continue" Enter
Sleep 1s
Type "y" Enter
Sleep 3s
Type "detent continue" Enter
Sleep 1s
Type "y" Enter
Sleep 3s
Type "clear" Enter
Type "# the plan stage raised the intent gate" Enter
Type "detent decide" Enter
Sleep 4s
Type "detent approve" Enter
Sleep 1s
Type "y" Enter
Sleep 4s
