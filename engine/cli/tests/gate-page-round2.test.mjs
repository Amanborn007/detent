import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, eventsOf, throughResearch } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CURATOR_CLI = join(REPO, "engine", "curator", "cli.mjs");
const EXAMPLE = join(REPO, "docs", "examples", "2026-10-20-amanborn007-detent-demo-1");
const BARE_PATH = "/usr/bin:/bin";
const NO_BROWSER = { CURATOR_NO_BROWSER: "1" };
const NEW_QUESTION = "Does this plan do what the brief asks, and nothing it does not ask for?";

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function toText(html) {
  const body = html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<style[\s\S]*?<\/style>/g, "");
  return unescape(body
    .replace(/<br\s*\/?>/g, "\n").replace(/<\/t[dh]>/g, " | ")
    .replace(/<\/(p|li|h[1-6]|tr|div|section|summary|dt|dd|ul|ol|table|details|header|footer|blockquote|pre)>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n");
}

function openGate({ ticket, files, decisions, gate }) {
  const ctx = mkRun({ ticket });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ctx.runDir, rel)), { recursive: true });
    if (content.from) copyFileSync(content.from, join(ctx.runDir, rel));
    else writeArtifact(ctx.runDir, rel, typeof content === "string" ? content : JSON.stringify(content));
  }
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-r2-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", gate, "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: BARE_PATH, TEST_CLONE: cdir, ...NO_BROWSER } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const html = readFileSync(r.json.html, "utf8");
  const mainHtml = html.split('<section id="raw">')[0];
  const rawHtml = html.slice(mainHtml.length);
  return { ctx, html, mainHtml, rawHtml, text: toText(html), mainText: toText(mainHtml), file: r.json.html };
}

const EXAMPLE_FILES = {
  "brief.md": { from: join(EXAMPLE, "brief.md") },
  "research.md": { from: join(EXAMPLE, "research.md") },
  "access-report.json": { from: join(EXAMPLE, "access-report.json") },
  "plan/plan.md": { from: join(EXAMPLE, "plan", "plan.md") },
  "recheck.md": { from: join(EXAMPLE, "recheck.md") },
};

function exampleDecisions() {
  return readJson(join(EXAMPLE, "decisions.json")).map((d) => {
    if (d.id !== "D-003") return d;
    const { answer, answered_by, answered_at, ...rest } = d;
    return { ...rest, status: "pending" };
  });
}

function example() {
  return openGate({ ticket: "Amanborn007/detent-demo#1", files: EXAMPLE_FILES, decisions: exampleDecisions(), gate: "intent" });
}

const Q1 = "What should slugify do with maxLength: null? (undefined means the option was not given.)";

test("in the main body a decision reference is a short link plus the answer, never the question", () => {
  const { mainHtml, mainText } = example();
  assert.ok(mainText.includes("D-001 (answered: treat null like undefined (no cap))"), mainText);
  assert.match(mainHtml, /<a href="#decision-D-001">D-001<\/a>/);
  assert.ok(mainHtml.includes('id="decision-D-001"'), "the link has a target");
  const occurrences = mainText.split(Q1).length - 1;
  assert.equal(occurrences, 1, "the full question appears once, in Already answered");
  assert.ok(!/“What should slugify/.test(mainText));
});

test("in raw artifacts the text stays as written and the id is only linked", () => {
  const { rawHtml } = example();
  assert.match(rawHtml, /\(-&gt; <a href="#decision-D-001">D-001<\/a>\)/);
  assert.ok(!/answered: treat null/.test(rawHtml), "no inlined answers in raw artifacts");
});

test("a plan step that depends on an answered decision says so, in plain words", () => {
  const { mainText } = example();
  assert.ok(mainText.includes("Depends on D-001 (answered: treat null like undefined (no cap))"), mainText);
  assert.ok(!/CONDITIONAL/.test(mainText));
});

test("a plan step that depends on an open decision says it waits", () => {
  const { mainText } = openGate({
    ticket: "octo/repo#20",
    files: {
      "brief.md": "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] one\n",
      "research.md": "# R\n",
      "access-report.json": [],
      "plan/plan.md": "# Plan\n\n## Steps\n1. CONDITIONAL on D-001. Handle null. Files: `a.js`. Verify: `npm test`.\n\n## Files touched\n- `a.js`\n\n## Risks\n- r\n\n## Intent check\n| Acceptance criterion | Covered by | Verdict |\n|---|---|---|\n| one | step 1 | covered |\n",
    },
    decisions: [
      { id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Null means what?", options: ["no cap", "throw"], status: "pending" },
      { id: "D-002", gate: "intent", raised_by: "engine", blocks: ["implement"], question: NEW_QUESTION, options: ["approve", "revise"], status: "pending" },
    ],
    gate: "intent",
  });
  assert.ok(mainText.includes("Waits on D-001 (open, below)"), mainText);
});

test("the intent gate shows plan.md's Intent check as coverage, in the folded background before the decision", () => {
  const { mainHtml, mainText } = example();
  const h = mainText.indexOf("Criteria: 7 of 7 met");
  const decide = mainText.indexOf(NEW_QUESTION);
  assert.ok(h > 0 && decide > h, "the coverage summary precedes the decision");
  const rows = [...mainHtml.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((m) => m.slice(1).map((c) => unescape(c.replace(/<[^>]+>/g, ""))));
  const cover = rows.filter((r) => /^(covered|not checked|partial|missing)/i.test(r[2]));
  assert.equal(cover.length, 7, JSON.stringify(rows));
  assert.ok(cover.every((r) => r[2] === "covered"));
  assert.ok(cover.some((r) => r[0].includes("The cut lands on a separator") && r[1].includes("step 1 test, step 2")));
  assert.ok(mainText.includes("Additions: step 4"));
  assert.ok(!mainText.includes("☐"), "the bare checkbox list is replaced by the coverage table");
});

test("an acceptance criterion the Intent check never mentions is marked not checked", () => {
  const { mainHtml } = openGate({
    ticket: "octo/repo#21",
    files: {
      "brief.md": "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] first thing works\n- [ ] second thing works\n",
      "research.md": "# R\n",
      "access-report.json": [],
      "plan/plan.md": "# Plan\n\n## Steps\n1. s. Files: `a`. Verify: `t`.\n\n## Risks\n- r\n\n## Intent check\n| Acceptance criterion | Covered by | Verdict |\n|---|---|---|\n| first thing works | step 1 | covered |\n",
    },
    decisions: [{ id: "D-001", gate: "intent", raised_by: "engine", blocks: ["implement"], question: NEW_QUESTION, options: ["approve", "revise"], status: "pending" }],
    gate: "intent",
  });
  assert.match(mainHtml, /<td>second thing works<\/td><td>[^<]*<\/td><td>not checked<\/td>/);
});

test("a plan with no Intent check shows a notice, the raw plan open, and a warning event", () => {
  const { ctx, html, text } = openGate({
    ticket: "octo/repo#22",
    files: {
      "brief.md": "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] first thing works\n",
      "research.md": "# R\n",
      "access-report.json": [],
      "plan/plan.md": "# Plan\n\n## Steps\n1. s. Files: `a`. Verify: `t`.\n\n## Risks\n- r\n",
    },
    decisions: [{ id: "D-001", gate: "intent", raised_by: "engine", blocks: ["implement"], question: NEW_QUESTION, options: ["approve", "revise"], status: "pending" }],
    gate: "intent",
  });
  assert.ok(text.includes("plan/plan.md has no ## Intent check section; the raw file is shown below"));
  assert.match(html, /<details open[^>]*>\s*<summary[^>]*>plan\/plan\.md/);
  assert.ok(text.includes("first thing works"), "criteria are still listed");
  const warns = eventsOf(ctx.runDir).filter((e) => e.event === "warning" && e.section === "## Intent check");
  assert.equal(warns.length, 1, JSON.stringify(warns));
});

test("the engine words the intent gate question in plain language", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  assert.equal(gate.question, NEW_QUESTION);
  assert.deepEqual(gate.options, ["approve", "revise"]);
});

test("the approve/revise gate carries no empty recommendation line, other decisions keep it", () => {
  assert.ok(!example().text.includes("no recommendation given"));
  const { text } = openGate({
    ticket: "octo/repo#23",
    files: { "brief.md": "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] x\n" },
    decisions: [{ id: "D-009", raised_by: "intake", blocks: ["implement"], question: "Which one?", options: ["a", "b"], status: "pending" }],
    gate: "D-009",
  });
  assert.ok(text.includes("no recommendation given"));
});

test("a fully reachable access report is one sentence with the status grid folded", () => {
  const { html, mainText } = example();
  const section = html.slice(html.indexOf('<section id="access">'), html.indexOf("</section>", html.indexOf('<section id="access">')));
  assert.ok(mainText.includes("All 4 sources were reachable, so nothing blocks this decision."));
  assert.match(section, /<details class="sec">\s*<summary[^>]*>[\s\S]*?<\/summary>[\s\S]*?<div class="grid">/);
  assert.equal((section.match(/<span class="mark" data-verdict="reached">✓ reached<\/span>/g) || []).length, 4);
});

test("a blocked source opens the access grid, ahead of the background plan and the decision", () => {
  const { html } = openGate({
    ticket: "octo/repo#24",
    files: {
      "brief.md": "# Brief\n\n## Goal\nGOALTEXT.\n\n## Acceptance criteria\n- [ ] x\n",
      "research.md": "# R\n",
      "access-report.json": [{ source: "jira", status: "blocked", criticality: "critical", needed_for: "ticket", blocked_reason: "vpn down", enable_action: "connect VPN" }],
      "plan/plan.md": "# Plan\n\n## Steps\n1. s. Files: `a`. Verify: `t`.\n\n## Risks\n- r\n\n## Intent check\n| a | b | c |\n|---|---|---|\n| x | 1 | covered |\n",
    },
    decisions: [{ id: "D-001", gate: "intent", raised_by: "engine", blocks: ["implement"], question: NEW_QUESTION, options: ["approve", "revise"], status: "pending" }],
    gate: "intent",
  });
  const start = html.indexOf('<section id="access">');
  const section = html.slice(start, html.indexOf("</section>", start));
  assert.match(section, /<details class="sec" open>/, "a blocked source auto-opens the section");
  assert.ok(section.includes('data-verdict="blocked">✕ blocked') && section.includes("vpn down"));
  assert.ok(start < html.indexOf("data-plan-question=") && start < html.indexOf('id="plan"'));
});

test("run artifacts are all collapsed, and option cards keep label and consequence apart", () => {
  const { html, mainHtml, rawHtml } = example();
  const opens = [...html.matchAll(/<details([^>]*)>/g)].map((m) => m[1]);
  assert.ok(opens.length >= 3);
  assert.ok(opens.every((a) => !/\bopen\b/.test(a)), "nothing is expanded on a well-formed run");
  assert.ok(!mainHtml.includes("<details") || mainHtml.indexOf("<details") > mainHtml.indexOf('id="background"'), "background folds start inside the background section");
  assert.ok(!/<details/.test(mainHtml.slice(mainHtml.indexOf('<section id="decide">'))), "nothing folds in the decision");
  assert.ok((rawHtml.match(/<details/g) || []).length >= 3);
  const card = /<div[^>]*data-plan-option="approve"[^>]*>([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(card, /<strong>Approve the plan<\/strong>\s*<p[^>]*data-plan-consequence[^>]*>Unlocks implementation of the approved plan steps\.<\/p>/);
  assert.match(html, /data-plan-option="approve"/);
});

test("the round two page passes the curator artifact check", () => {
  const { file } = example();
  const chk = spawnSync(process.execPath, [CURATOR_CLI, "check", file], { encoding: "utf8", env: { ...process.env, ...NO_BROWSER } });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
});

test("the intent decision block carries no engine file path and no bare decision id", () => {
  const { html } = example();
  const start = html.indexOf('<section id="decide">');
  const block = html.slice(start, html.indexOf("</section>", start));
  assert.ok(block.includes("data-plan-question="), "the slice holds the decision");
  assert.ok(!block.includes("Context: plan/plan.md"), "the intent gate always reviews plan.md, so the path is noise");
  assert.ok(!/<p class="small">D-\d+<\/p>/.test(block), "a lone decision id tells a reviewer nothing");
});
