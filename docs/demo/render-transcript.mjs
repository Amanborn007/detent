#!/usr/bin/env node
// Replays a `claude -p --verbose --output-format stream-json` transcript as terminal-style text, and optionally as one
// self-contained HTML page. Usage: node render-transcript.mjs <transcript.jsonl|-> [--html out.html] [--prompt "text"]
import { readFileSync, writeFileSync } from "node:fs";

const RESULT_LINES = 4;
const LINE_MAX = 160;
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "skill", "description"];

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function parseTranscript(text, name = "transcript") {
  const events = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    try { events.push(JSON.parse(raw)); } catch (e) { throw new Error(`${name} line ${i + 1} is not JSON: ${e.message}`); }
  });
  return events;
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "");

function toolSummary(block) {
  const input = block.input || {};
  const key = SUMMARY_KEYS.find((k) => typeof input[k] === "string" && input[k]);
  return `${block.name}(${key ? cut(input[key].replace(/\s+/g, " "), 100) : ""})`;
}

/** Flatten events into display items: {kind: prompt|text|tool|result|error|done, ...}. Other event types (system, hooks, stream deltas) carry no conversation. */
export function toItems(events, promptOverride) {
  const items = [];
  let sawPrompt = false;
  if (promptOverride) { items.push({ kind: "prompt", text: promptOverride }); sawPrompt = true; }
  for (const ev of events) {
    const content = ev.message?.content;
    if (ev.type === "user") {
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const b of results) {
        const body = textOf(b.content);
        items.push({ kind: b.is_error ? "error" : "result", text: body });
      }
      const said = results.length ? "" : textOf(content);
      if (said && !sawPrompt) { items.push({ kind: "prompt", text: said }); sawPrompt = true; }
    } else if (ev.type === "assistant") {
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "text" && b.text.trim()) items.push({ kind: "text", text: b.text.trim() });
        else if (b.type === "tool_use") items.push({ kind: "tool", text: toolSummary(b) });
      }
    } else if (ev.type === "result") {
      const secs = typeof ev.duration_ms === "number" ? `${(ev.duration_ms / 1000).toFixed(1)}s` : null;
      const parts = [secs && `done in ${secs}`, ev.num_turns != null && `${ev.num_turns} turns`, ev.total_cost_usd != null && `$${ev.total_cost_usd}`].filter(Boolean);
      items.push({ kind: ev.is_error ? "error" : "done", text: ev.is_error ? `failed: ${ev.result ?? ev.subtype}` : parts.join(", ") });
    }
  }
  return items;
}

/** First lines of a tool result, each capped, with a count of what was left out. */
function resultLines(text) {
  const all = text.replace(/\s+$/, "").split("\n");
  const shown = all.slice(0, RESULT_LINES).map((l) => cut(l, LINE_MAX));
  return { shown, more: all.length - shown.length, rest: all.slice(RESULT_LINES) };
}

export function renderText(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === "prompt") out.push(`> ${it.text}`, "");
    else if (it.kind === "text") out.push(it.text, "");
    else if (it.kind === "tool") out.push(`● ${it.text}`);
    else if (it.kind === "result" || it.kind === "error") {
      const { shown, more } = resultLines(it.text);
      const head = it.kind === "error" ? "error: " : "";
      out.push(`  ⎿ ${head}${shown[0] ?? ""}`, ...shown.slice(1).map((l) => `     ${l}`));
      if (more > 0) out.push(`     … +${more} more lines`);
      out.push("");
    } else out.push(`— ${it.text}`);
  }
  return out.join("\n") + "\n";
}

export function renderHtml(items, title) {
  const body = items.map((it) => {
    if (it.kind === "prompt") return `<div class="prompt"><span class="mark">&gt;</span> ${esc(it.text)}</div>`;
    if (it.kind === "text") return `<p class="say">${esc(it.text)}</p>`;
    if (it.kind === "tool") return `<div class="tool"><span class="mark">●</span> ${esc(it.text)}</div>`;
    if (it.kind === "result" || it.kind === "error") {
      const { shown, more, rest } = resultLines(it.text);
      const more_ = more > 0 ? `<details><summary>… +${more} more lines</summary><pre>${esc(rest.join("\n"))}</pre></details>` : "";
      return `<pre class="${it.kind}">${esc((it.kind === "error" ? "error: " : "") + shown.join("\n"))}</pre>${more_}`;
    }
    return `<div class="done">${esc(it.text)}</div>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1f2328;--dim:#6a737d;--line:#d8d4cc;--accent:#1a6bd1;--err:#b3261e;--panel:#f1eee8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#16181c;--fg:#e6e6e6;--dim:#9aa0a6;--line:#2c3036;--accent:#6fb1ff;--err:#ff8a80;--panel:#1d2025}}
:root[data-theme="dark"]{--bg:#16181c;--fg:#e6e6e6;--dim:#9aa0a6;--line:#2c3036;--accent:#6fb1ff;--err:#ff8a80;--panel:#1d2025}
body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding-inline:max(16px,4vw);padding-block:24px;margin:0}
main{max-width:880px;margin:0 auto}
h1{font:600 15px/1.4 system-ui,sans-serif;color:var(--dim);margin:0 0 16px}
.prompt{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:16px 0}
.mark{color:var(--accent)}
.say{margin:12px 0;white-space:pre-wrap;font-family:system-ui,sans-serif;font-size:14px}
.tool{margin:8px 0 0;overflow-wrap:anywhere}
pre{margin:2px 0 12px 1.5em;color:var(--dim);white-space:pre-wrap;overflow-wrap:anywhere}
pre.error{color:var(--err)}
details{margin:0 0 12px 1.5em;color:var(--dim)}
details pre{margin:4px 0 0}
summary{cursor:pointer}
.done{color:var(--dim);border-top:1px solid var(--line);margin-top:16px;padding-top:8px}
</style></head><body><main>
<h1>${esc(title)}</h1>
${body}
</main></body></html>
`;
}

function main(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--html" || a === "--prompt") {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 1) throw new Error("usage: render-transcript.mjs <transcript.jsonl|-> [--html out.html] [--prompt \"text\"]");
  const file = pos[0];
  const items = toItems(parseTranscript(readFileSync(file === "-" ? 0 : file, "utf8"), file), flags.prompt);
  process.stdout.write(renderText(items));
  if (flags.html) writeFileSync(flags.html, renderHtml(items, "detent in Claude Code: replay"));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`render-transcript: ${e.message}\n`); process.exit(2); }
}
