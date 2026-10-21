# Render from the repo root:  vhs docs/demo/demo.tape   (or: node docs/demo/render-fallback.mjs)
# Offline and deterministic: no LLM, no network, no credentials. Runs the real engine on a throwaway repo.
Output docs/demo/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 540
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set PlaybackSpeed 1

Hide
Type "source docs/demo/demo-env.sh" Enter
Sleep 2s
Show

Type "# one ticket, setup to plan gate. A stub stands in for the tracker, so this is offline." Enter
Sleep 2s
Type "detent setup --repo . | say setup" Enter
Sleep 2s
Type "detent run new --ticket acme/widgets#1 --repo . | say run" Enter
Sleep 2s
Type "# Claude writes each stage's file. Canned files stand in. The engine checks are real." Enter
Type "stages" Enter
Sleep 4s
Type "detent gate open intent | say gate" Enter
Sleep 5s
