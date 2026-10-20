# Render from the repo root:  vhs docs/demo/demo.tape
# Offline and deterministic: no LLM, no network, no credentials. Runs the real engine on a throwaway repo.
Output docs/demo/demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1100
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set PlaybackSpeed 1

Hide
Type "source docs/demo/demo-env.sh" Enter
Sleep 2s
Show

Type "# detent walks a ticket through gated stages. The engine is the state machine." Enter
Sleep 2s
Type "detent run new --ticket DEMO-42 --slug banner --no-worktree | pj" Enter
Sleep 4s

Type "detent next | pj" Enter
Sleep 4s

Type "# try to skip ahead to plan" Enter
Type "detent stage begin plan | pj" Enter
Sleep 5s

Type "# do intake properly. Ending it without brief.md is refused too" Enter
Type "detent stage begin intake | pj >/dev/null; detent stage end intake | pj" Enter
Sleep 5s

Type "brief DEMO-42; detent stage end intake | pj" Enter
Sleep 5s

Type "# sockets: your tracker, knowledge and reviewers plug in via YAML. ON/OFF is explicit" Enter
Type "detent pack validate --pack packs/example/stack.yaml | packs" Enter
Sleep 6s

Type "# every stage ends at a gate you answer in curator. Detent never merges." Enter
Sleep 3s
