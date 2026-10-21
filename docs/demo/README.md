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

## Terminal track

`terminal.tape` drives the friendly verbs end to end on a throwaway clone of `acme/widgets`: `detent doctor`, `detent start acme/widgets#1` (which also builds the repo index and prints one line with its counts), `status`, three `continue` steps, `decide` and `approve`. Stand-ins, all offline: `fixtures/stub-claude.mjs` writes each stage's file from `fixtures/term/`, `fixtures/stub-gh-term` answers `gh`, `fixtures/bin/curator` answers `curator`, and `fixtures/stub-ticket` answers the ticket socket. The engine is real. `terminal-env.sh` builds the repo and defines `detent`.

`terminal-smoke.sh` runs the same commands without vhs and asserts the key output lines; `smoke.sh` calls it. To render the GIF, run `vhs docs/demo/terminal.tape` from the repo root. The GIF is not committed until it has been rendered with vhs.

## Claude Code track

`transcripts/status.jsonl` and `transcripts/continue.jsonl` are real `claude -p --verbose --output-format stream-json --plugin-dir <checkout> "/detent:status"` sessions (and `/detent:continue`) run inside the same throwaway repo, so detent here is the plugin skills calling the real engine. `scrub-transcript.sh` keeps only the user, assistant and result events, opens each file with the prompt, rewrites machine paths the way `scripts/export-example.sh` does, and runs `company-strings-check`.

`render-transcript.mjs` replays transcripts as terminal-style text and, with `--html`, as one self-contained page with no script and no external resource:

```sh
node docs/demo/render-transcript.mjs docs/demo/transcripts/status.jsonl docs/demo/transcripts/continue.jsonl --html docs/demo/claude-code.html
```

Tests: `node --test docs/demo/test/`.
