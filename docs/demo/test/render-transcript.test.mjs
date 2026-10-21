// render-transcript turns a `claude -p --verbose --output-format stream-json` transcript into a terminal-style replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "render-transcript.mjs");
const SAMPLE = join(HERE, "fixtures", "sample.jsonl");
const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", input });

test("replay shows the prompt, assistant text, one-line tool calls, truncated results, and the outcome", () => {
  const r = run([SAMPLE]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.ok(lines.includes("> /detent:status"));
  assert.ok(lines.includes("I will check where the run stands."));
  assert.ok(lines.includes("● Bash(node /plugin/engine/cli/detent.mjs status)"));
  assert.ok(lines.includes("● Read(/work/missing.md)"));
  assert.ok(lines.includes("  ⎿ Run demo-1 (acme/widgets#1)"), r.stdout);
  assert.match(r.stdout, /  \s+… \+\d+ more lines/);
  assert.ok(!r.stdout.includes("· recheck"), "result is cut to the first lines");
  assert.ok(lines.includes("  ⎿ error: File does not exist."));
  assert.match(r.stdout, /done in 4\.2s, 3 turns, \$0\.0123/);
});

test("system events such as hooks are left out", () => {
  const r = run([SAMPLE]);
  assert.doesNotMatch(r.stdout, /SessionStart|hook/);
});

test("--prompt supplies the prompt when the transcript has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-"));
  const f = join(dir, "t.jsonl");
  const body = readFileSync(SAMPLE, "utf8").split("\n").filter((l) => !l.includes('"content":"/detent:status"')).join("\n");
  writeFileSync(f, body);
  const r = run([f, "--prompt", "/detent:status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split("\n").includes("> /detent:status"));
});

test("--html writes one self-contained page with every piece escaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-"));
  const out = join(dir, "page.html");
  const r = run([SAMPLE, "--html", out]);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(out, "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.doesNotMatch(html, /<script/i, "no script, so nothing from the transcript can run");
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i, "no external resources");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("detent.mjs status"));
});

test("a line that is not JSON fails loudly with its line number", () => {
  const r = run(["-"], '{"type":"result","subtype":"success"}\nnot json\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /line 2/);
});

test("a missing file fails loudly", () => {
  const r = run([join(HERE, "fixtures", "nope.jsonl")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nope\.jsonl/);
});
