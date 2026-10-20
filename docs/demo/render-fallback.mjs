#!/usr/bin/env node
// Fallback renderer when `vhs` is not installed: replays the Type lines of demo.tape against the
// real engine, draws terminal frames in headless Chrome, and joins them into demo.gif with ffmpeg.
// Usage (repo root): node docs/demo/render-fallback.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1100, H = 640;

// 1. Parse the tape: commands typed after Show, with the sleep that follows each.
const tape = readFileSync(join(here, "demo.tape"), "utf8").split("\n");
const steps = [];
let shown = false;
for (const line of tape) {
  if (line.startsWith("Show")) { shown = true; continue; }
  if (!shown) continue;
  const t = line.match(/^Type "(.*)" Enter$/);
  if (t) steps.push({ cmd: t[1].replace(/\\"/g, '"'), sleep: 1 });
  const s = line.match(/^Sleep ([\d.]+)s$/);
  if (s && steps.length) steps[steps.length - 1].sleep = Number(s[1]);
}

// 2. Run them for real, one bash session, output split by markers.
const work = mkdtempSync(join(tmpdir(), "detent-demo-"));
const MARK = "@@STEP@@";
const script = [`export DEMO_TMP=${JSON.stringify(work + "/state")}`, `source ${JSON.stringify(join(here, "demo-env.sh"))} >/dev/null 2>&1`]
  .concat(steps.map((s) => `echo ${MARK}; ${s.cmd}`)).join("\n");
const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
const outs = run.stdout.split(MARK + "\n").slice(1).map((o) => o.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\n$/, ""));
if (outs.length !== steps.length) throw new Error(`expected ${steps.length} outputs, got ${outs.length}\n${run.stderr}`);

// 3. Frames: typing progress, then output.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const colour = (l) => {
  if (l.startsWith("#")) return `<span class=c>${esc(l)}</span>`;
  return esc(l)
    .replace(/("ok": )true/, '$1<span class=g>true</span>')
    .replace(/("ok": )false/, '$1<span class=r>false</span>')
    .replace(/(&quot;|")(reason)(&quot;|")/, '$1<span class=r>$2</span>$3')
    .replace(/\bON\b/, '<span class=g>ON</span>')
    .replace(/\bOFF\b/, '<span class=y>OFF</span>');
};
const page = (lines, cursor) => `<!doctype html><meta charset=utf-8><style>
body{margin:0;background:#1e1e2e;color:#cdd6f4;font:20px/1.45 Menlo,Monaco,monospace}
.t{height:${H - 48}px;padding:24px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;white-space:pre}
.c{color:#6c7086}.g{color:#a6e3a1}.r{color:#f38ba8}.y{color:#f9e2af}.p{color:#89b4fa}
.cur{background:#cdd6f4;color:#1e1e2e}</style><div class=t>${(lines.length ? lines : [""]).map((l, i, a) => `<div>${l || " "}${cursor && i === a.length - 1 ? '<span class=cur> </span>' : ""}</div>`).join("")}</div>`;

const frames = [];
const frameDir = join(work, "frames"); mkdirSync(frameDir);
let history = [];
const emit = (lines, cursor, dur) => {
  const n = frames.length, f = join(frameDir, `f${String(n).padStart(3, "0")}.html`);
  writeFileSync(f, page(lines, cursor));
  frames.push({ html: f, png: f.replace(".html", ".png"), dur });
};
emit([], true, 0.8);
steps.forEach((s, i) => {
  const prompt = `<span class=p>$</span> `;
  const chunk = Math.max(3, Math.ceil(s.cmd.length / 5));
  for (let k = chunk; k < s.cmd.length; k += chunk) emit([...history, prompt + colour(s.cmd.slice(0, k))], true, 0.18);
  const typed = prompt + colour(s.cmd);
  const out = outs[i] ? outs[i].split("\n").map(colour) : [];
  history = [...history, typed, ...out];
  emit(history, true, s.cmd.startsWith("#") ? 1.2 : Math.min(s.sleep, 5));
});

for (const f of frames) {
  const r = spawnSync(CHROME, ["--headless", "--disable-gpu", `--user-data-dir=${join(work, "chrome")}`, "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, `--screenshot=${f.png}`, `file://${f.html}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`chrome failed: ${r.stderr}`);
}

// 4. Join with ffmpeg (concat demuxer with per-frame durations, shared palette).
const list = frames.map((f) => `file '${f.png}'\nduration ${f.dur}`).join("\n") + `\nfile '${frames.at(-1).png}'\n`;
writeFileSync(join(work, "list.txt"), list);
const out = resolve(here, "demo.gif");
const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"),
  "-vf", "fps=10,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse=dither=none", out], { encoding: "utf8" });
if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr}`);
const total = frames.reduce((a, f) => a + f.dur, 0);
console.log(`wrote ${out} (${frames.length} frames, ~${total.toFixed(1)}s)`);
rmSync(work, { recursive: true, force: true });
