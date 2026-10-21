# Demo GIF

`demo.gif` runs the real engine from `detent setup` to the plan gate on one offline ticket: `setup`, `run new`, one line per stage, then `gate open`, which prints "waiting on you: intent gate D-001 (approve or revise)" and the path of the gate page. It makes no network call and uses no LLM. It runs on a throwaway repo and a throwaway `DETENT_ROOT`.

Two things are stand-ins, and the GIF says so. `fixtures/stub-ticket` answers the ticket socket in place of `gh-ticket`, and `fixtures/*.md` replace the files Claude writes at each stage. Every stage transition, refusal and gate comes from the engine.

- `demo.tape` is the source of truth for what is typed.
- `demo-env.sh` builds the throwaway repo and defines `detent`, `say` and `stages`.
- `say.mjs` turns one engine JSON line into one readable line. Every status, id and path it prints comes from that JSON; only the "on disk" file names are passed in by `stages`.
- `smoke.sh` replays the flow and exits non-zero if any `ok` differs from the expected one.

Re-render with [vhs](https://github.com/charmbracelet/vhs) from the repo root:

```sh
brew install vhs
vhs docs/demo/demo.tape
```

Prerequisites: `curator` on PATH (the gate page and `smoke.sh` need it). Re-rendering also needs Chrome and ffmpeg (macOS paths; override Chrome with `CHROME=`).

Without vhs, `render-fallback.mjs` replays the `Type` lines from `demo.tape` using headless Chrome and ffmpeg (macOS paths, override Chrome with `CHROME=`). It also screenshots the gate page the run opened into `docs/assets/demo-gate.png` and `demo-gate-dark.png`:

```sh
node docs/demo/render-fallback.mjs
```

Check the flow without rendering: `bash docs/demo/smoke.sh`.

A recording of the real thing inside Claude Code is scripted in [RECORDING.md](RECORDING.md).
