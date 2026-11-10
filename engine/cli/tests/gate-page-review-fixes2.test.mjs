import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, writeJson, readJson, eventsOf } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "..", "..", "..", "docs", "examples", "2026-10-20-amanborn007-detent-demo-1");
const Q = "Does this plan do what the brief asks, and nothing it does not ask for?";
const INTENT = { id: "D-001", gate: "intent", raised_by: "engine", blocks: ["implement"], question: Q, options: ["approve", "revise"], context: "plan/plan.md", status: "pending" };

function open({ files, decisions, gate = "intent", ticket = "octo/repo#9" }) {
  const ctx = mkRun({ ticket });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ctx.runDir, rel)), { recursive: true });
    if (content.from) copyFileSync(content.from, join(ctx.runDir, rel));
    else writeArtifact(ctx.runDir, rel, content);
  }
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-fixes-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", gate, "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: "/usr/bin:/bin", TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const html = readFileSync(r.json.html, "utf8");
  return { ctx, html, decide: /<section id="decide">[\s\S]*?<\/section>/.exec(html)[0], cover: (/<section id="cover">[\s\S]*?<\/section>/.exec(html) || [""])[0] };
}

const brief = (...cs) => `# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n${cs.map((c) => `- [ ] ${c}`).join("\n")}\n`;
const plan = (rows) => `# Plan\n\n## Steps\n1. s. Files: \`a\`. Verify: \`t\`.\n\n## Risks\n- r\n\n## Intent check\n| Acceptance criterion | Covered by | Verdict |\n|---|---|---|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
const run = (b, rows) => open({ files: { "brief.md": b, "research.md": "# R\n", "access-report.json": "[]", "plan/plan.md": plan(rows) }, decisions: [INTENT] });
const done = (html) => /<p data-brief="done">([\s\S]*?)<\/p>/.exec(html)[1].replace(/<[^>]+>/g, "");

test("a subset criterion does not steal the verdict of the longer one when rows are reversed", () => {
  const { cover } = run(brief("widget renders", "widget renders correctly on mobile"), [
    ["widget renders correctly on mobile", "step 2", "MISSING"],
    ["widget renders", "step 1", "covered"],
  ]);
  assert.match(cover, /<td>widget renders<\/td><td>step 1<\/td><td>covered<\/td>/);
  assert.match(cover, /<td>widget renders correctly on mobile<\/td><td>step 2<\/td><td>MISSING<\/td>/);
});

test("rows that match no criterion are listed apart and do not count as covered", () => {
  const { cover, html } = run(brief("alpha widget renders correctly", "beta export succeeds quickly"), [
    ["alpha widget renders correctly", "step 1", "covered"],
    ["zebra unrelated extra thing", "step 3", "covered"],
  ]);
  const [main, extra] = cover.split("Plan rows that match no brief criterion");
  assert.ok(extra, cover);
  assert.match(main, /<td>beta export succeeds quickly<\/td><td>none<\/td><td>not checked<\/td>/);
  assert.ok(!main.includes("zebra"), "the unmatched row is not under Acceptance criterion");
  assert.match(extra, /<td>zebra unrelated extra thing<\/td><td>step 3<\/td><td>covered<\/td>/);
  assert.match(done(html), /covers 1 of 2 criteria/);
});

test("the summary says criterion in the singular", () => {
  const { html } = run(brief("alpha widget renders correctly"), [["alpha widget renders correctly", "step 1", "covered"]]);
  assert.match(done(html), /covers 1 of 1 criterion\b(?!a)/);
  assert.ok(!/1 of 1 criteria/.test(done(html)));
});
