# Demo GIF

`demo.gif` shows the real engine refusing an illegal stage jump, refusing to end intake without `brief.md`, accepting it once the brief exists, and listing which sockets are ON or OFF. It is offline: no LLM, no network, no credentials. It runs on a throwaway repo and a throwaway `DETENT_ROOT`.

Re-render with [vhs](https://github.com/charmbracelet/vhs) from the repo root:

```sh
brew install vhs
vhs docs/demo/demo.tape
```

Without vhs, this replays the same `Type` lines from `demo.tape` using headless Chrome and ffmpeg (macOS paths, override Chrome with `CHROME=`):

```sh
node docs/demo/render-fallback.mjs
```

To print the demo output without rendering: `bash docs/demo/smoke.sh`. It does not assert anything; read the output.
