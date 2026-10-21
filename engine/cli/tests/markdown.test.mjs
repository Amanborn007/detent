import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../markdown.mjs";
import { engine, mkRun, writeArtifact, throughResearch } from "./helpers.mjs";

const CURATOR_CLI = join(fileURLToPath(import.meta.url), "..", "..", "..", "curator", "cli.mjs");

test("headings are demoted so an artifact h1 sits under the page's h2", () => {
  const html = renderMarkdown("# Plan\n\n## Approach\n");
  assert.match(html, /<h3>Plan<\/h3>/);
  assert.match(html, /<h4>Approach<\/h4>/);
  assert.doesNotMatch(html, /#/);
});

test("inline bold, italic, code and links render; markers do not leak", () => {
  const html = renderMarkdown("Source is **reachable**, *degraded*, `repo-export`, [docs](https://example.com/a).");
  assert.match(html, /<strong>reachable<\/strong>/);
  assert.match(html, /<em>degraded<\/em>/);
  assert.match(html, /<code>repo-export<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a"[^>]*>docs<\/a>/);
  assert.doesNotMatch(html, /\*\*|`/);
});

test("code spans keep their contents literal", () => {
  const html = renderMarkdown("Use `[^a-z0-9]` and `**not bold**`.");
  assert.match(html, /<code>\[\^a-z0-9\]<\/code>/);
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
});

test("ordered list with a nested bullet list and a lazy continuation line", () => {
  const md = "1. **Add tests.** Add these:\n   - `a`: one\n   - `b`: two\ncontinued\n2. Second step\n";
  const html = renderMarkdown(md);
  assert.match(html, /<ol>\s*<li>/);
  assert.match(html, /<ul>\s*<li><code>a<\/code>: one<\/li>/);
  assert.match(html, /two continued<\/li>/);
  assert.match(html, /<li>Second step<\/li>\s*<\/ol>/);
});

test("fenced code, blockquote, table and rule", () => {
  const md = "```py\nx = 1 < 2\n```\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n";
  const html = renderMarkdown(md);
  assert.match(html, /<pre><code>x = 1 &lt; 2\n?<\/code><\/pre>/);
  assert.match(html, /<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>/);
  assert.match(html, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<hr>/);
});

test("raw HTML and unsafe link schemes are neutralised", () => {
  const html = renderMarkdown("<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](data:text/html,hi)");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="(javascript|data):/i);
});

test("gate page renders plan.md as formatted markdown, not raw text", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# Plan\n\n## Approach\nThe fix is **simple** and uses `re.sub`.\n\n1. First step\n");
  engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  const binDir = join(tmpdir(), "engine-md-bin-" + process.pid);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "curator"), "#!/bin/sh\necho stub-curator\n");
  chmodSync(join(binDir, "curator"), 0o755);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: binDir + ":/usr/bin:/bin" } });
  assert.equal(r.code, 0, r.stdout);
  const page = readFileSync(r.json.html, "utf8");
  assert.match(page, /<h4>Approach<\/h4>/);
  assert.match(page, /<strong>simple<\/strong>/);
  assert.match(page, /<ol>\s*<li>First step<\/li>/);
  assert.doesNotMatch(page, /## Approach|\*\*simple\*\*/);
});

test("emphasis markers inside a link target do not corrupt the href", () => {
  const html = renderMarkdown("[a](https://x/) [b](https://y/a_) [c](https://e.com/*a*)");
  assert.match(html, /href="https:\/\/y\/a_"/);
  assert.match(html, /href="https:\/\/e\.com\/\*a\*"/);
  assert.doesNotMatch(html, /<em>/);
});

test("a stray NUL placeholder in input renders as nothing, not 'undefined'", () => {
  assert.doesNotMatch(renderMarkdown("x \u00007\u0000 y"), /undefined/);
});

test("links open in the same frame, since the curator iframe blocks popups", () => {
  assert.doesNotMatch(renderMarkdown("[a](https://x/)"), /target=/);
});

test("a blank line after a nested list keeps the parent list whole", () => {
  const html = renderMarkdown("- a\n  - b\n\n- c\n");
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.match(html, /<li>c<\/li>\s*<\/ul>\s*$/);
});

test("a bare --- under a line containing a pipe is a rule, not an empty table", () => {
  assert.doesNotMatch(renderMarkdown("a | b\n---\n"), /<table>/);
});

test("a gate page with realistic plan prose passes curator check", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  const long = Array.from({ length: 120 }, () => "word").join(" ");
  const sections = Array.from({ length: 9 }, (_, n) => `## Section ${n}\n${long}\n`).join("\n");
  const steps = Array.from({ length: 6 }, (_, n) => `${n + 1}. Step ${n + 1}`).join("\n");
  writeArtifact(ctx.runDir, "plan/plan.md", `# Plan\n\n${sections}\n${steps}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`);
  engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  const binDir = join(tmpdir(), "engine-md-check-bin-" + process.pid);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "curator"), "#!/bin/sh\necho stub-curator\n");
  chmodSync(join(binDir, "curator"), 0o755);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: binDir + ":/usr/bin:/bin" } });
  assert.equal(r.code, 0, r.stdout);
  const chk = spawnSync(process.execPath, [CURATOR_CLI, "check", r.json.html], { encoding: "utf8" });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
});
