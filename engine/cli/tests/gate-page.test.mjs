import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, eventsOf } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CURATOR_CLI = join(REPO, "engine", "curator", "cli.mjs");
const EXAMPLE = join(REPO, "docs", "examples", "2026-10-20-amanborn007-detent-demo-1");
const DEMO = join(REPO, "docs", "demo", "fixtures");
const BARE_PATH = "/usr/bin:/bin";
const NO_BROWSER = { CURATOR_NO_BROWSER: "1" };

function unescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** What a reader sees: one text line per block, tags dropped. */
function toText(html) {
  const body = html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  return unescape(body
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|li|h[1-6]|tr|div|section|summary|dt|dd|ul|ol|table|details|header|footer|blockquote|pre)>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean)
    .join("\n");
}

/** The page above the collapsed run artifacts: what a reader decides from. */
const mainOf = (html) => html.split('<section id="raw">')[0];
/** Offset of the first collapsed artifact; the goal must read before it. */
const firstRawDetails = (html) => html.indexOf("<details", html.indexOf('<section id="raw">'));

function put(runDir, rel, from) {
  mkdirSync(dirname(join(runDir, rel)), { recursive: true });
  copyFileSync(from, join(runDir, rel));
}

/** Make a run, lay `files` and `decisions` into it, run the real `gate open`, and hand back the page. */
function openGate({ ticket, files, decisions, gate }) {
  const ctx = mkRun({ ticket });
  for (const [rel, content] of Object.entries(files)) {
    if (content.from) put(ctx.runDir, rel, content.from);
    else writeArtifact(ctx.runDir, rel, typeof content === "string" ? content : JSON.stringify(content));
  }
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-test-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", gate, "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: BARE_PATH, TEST_CLONE: cdir, ...NO_BROWSER } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.mode, "curator");
  const html = readFileSync(r.json.html, "utf8");
  return { ctx, html, text: toText(html), file: r.json.html };
}

function exampleDecisions() {
  const all = readJson(join(EXAMPLE, "decisions.json"));
  return all.map((d) => {
    if (d.id !== "D-003") return d;
    const { answer, answered_by, answered_at, ...rest } = d;
    return { ...rest, status: "pending" };
  });
}

const EXAMPLE_FILES = {
  "brief.md": { from: join(EXAMPLE, "brief.md") },
  "research.md": { from: join(EXAMPLE, "research.md") },
  "access-report.json": { from: join(EXAMPLE, "access-report.json") },
  "plan/plan.md": { from: join(EXAMPLE, "plan", "plan.md") },
  "recheck.md": { from: join(EXAMPLE, "recheck.md") },
};

function exampleIntentGate() {
  return openGate({ ticket: "Amanborn007/detent-demo#1", files: EXAMPLE_FILES, decisions: exampleDecisions(), gate: "intent" });
}

function checkPasses(file) {
  const chk = spawnSync(process.execPath, [CURATOR_CLI, "check", file], { encoding: "utf8", env: { ...process.env, ...NO_BROWSER } });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
}

test("intent gate page opens with a verdict sentence that explains Approve and Revise", () => {
  const { text } = exampleIntentGate();
  const lines = text.split("\n");
  assert.match(lines[0], /^You are deciding whether the plan for Amanborn007\/detent-demo#1 is ready to implement\.?$/);
  assert.ok(text.includes("Approve unlocks implementation"), text.slice(0, 600));
  assert.ok(text.includes("Revise sends the plan back with your note"));
});

test("the goal and acceptance criteria are on the page before any collapsed artifact", () => {
  const { html, text } = exampleIntentGate();
  const firstDetails = firstRawDetails(html);
  assert.ok(firstDetails > 0);
  const goal = html.indexOf("Callers can cap how long a slug gets");
  assert.ok(goal > 0 && goal < firstDetails, "goal text must precede the first <details>");
  assert.ok(/☐ slugify\(input, \{ maxLength \}\)/.test(text), "acceptance criteria render as a checklist");
});

test("GFM task lists render as ticks, never as literal brackets", () => {
  const { text } = exampleIntentGate();
  assert.ok(!/\[ \]|\[x\]/i.test(text), "no literal task-list brackets anywhere");
  assert.ok(/^☐ /m.test(text));
});

test("no line of the page starts with raw markdown, table pipes, or json", () => {
  const { text } = exampleIntentGate();
  for (const line of text.split("\n")) {
    assert.ok(!/^(#|\||\[ \]|\{")/.test(line), `raw line leaked: ${line}`);
  }
});

test("plan steps are numbered with their files and verify command", () => {
  const { text } = exampleIntentGate();
  assert.ok(text.includes("Files: test/slugify.test.js"));
  assert.ok(text.includes("Verify: npm test fails on the new tests only"));
  assert.ok(text.includes("src/index.js"), "files touched listed");
  assert.ok(text.includes("A multi-character separator could leave half a separator"), "risks listed");
});

test("the access panel is background after the decision on a plan gate, as a table", () => {
  const { html, text } = exampleIntentGate();
  const access = html.indexOf('id="access"');
  const decision = html.indexOf("data-plan-question=");
  const raw = html.indexOf('<section id="raw">');
  assert.ok(decision > 0 && access > decision && access < raw, "access panel follows the decision and precedes the raw artifacts");
  assert.ok(/<table[\s\S]*?target repo[\s\S]*?<\/table>/i.test(html.slice(access, raw)));
  assert.ok(text.includes("reachable"));
  assert.ok(!html.includes('{"source"'), "the raw access-report.json is not dumped");
});

test("an earlier decision shows its question and answer, and every D-id sits beside its question", () => {
  const text = toText(mainOf(exampleIntentGate().html));
  const decisions = readJson(join(EXAMPLE, "decisions.json"));
  assert.ok(text.includes("What should slugify do with maxLength: null?"));
  assert.ok(text.includes("treat null like undefined (no cap)"));
  const ids = [...text.matchAll(/D-\d+/g)];
  assert.ok(ids.length > 0);
  for (const m of ids) {
    const d = decisions.find((x) => x.id === m[0]);
    assert.ok(d, `unknown id ${m[0]}`);
    const probe = d.question.slice(0, 30);
    const window = text.slice(Math.max(0, m.index - 400), m.index + 400);
    assert.ok(window.includes(probe) || window.includes(`(answered: ${d.answer}`), `${m[0]} at ${m.index} has no question text near it (${probe})`);
  }
});

test("the pending decision shows its question first, then option cards that carry the exact option strings", () => {
  const { html, text } = exampleIntentGate();
  const options = [...html.matchAll(/data-plan-option="([^"]*)"/g)].map((m) => unescape(m[1]));
  assert.deepEqual(options, ["approve", "revise"]);
  assert.ok(html.includes('data-plan-question="D-003"'));
  const stored = exampleDecisions().find((d) => d.id === "D-003").question;
  const q = text.indexOf(stored);
  const card = text.indexOf("Unlocks implementation");
  assert.ok(q > 0 && card > q, "question precedes its option cards");
});

test("option strings with quotes and markup survive into data-plan-option exactly", () => {
  const options = ['use "quotes" & <tags>', "plain", "other (specify)"];
  const { html } = openGate({
    ticket: "octo/repo#7",
    files: { "brief.md": "# Brief: octo/repo#7\n\n## Goal\nDo it.\n\n## Acceptance criteria\n- [ ] done\n" },
    decisions: [{ id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which?", options, status: "pending" }],
    gate: "D-001",
  });
  const got = [...html.matchAll(/data-plan-option="([^"]*)"/g)].map((m) => unescape(m[1]));
  assert.deepEqual(got, options);
});

test("a later-stage artifact never appears on an earlier gate", () => {
  const { html, text } = exampleIntentGate();
  assert.ok(!text.includes("Step verdicts"));
  assert.ok(!/<summary[^>]*>[^<]*recheck\.md/.test(html));
  const sums = [...html.matchAll(/<summary[^>]*>([^<]*)<\/summary>/g)].map((m) => m[1]);
  assert.ok(sums.some((s) => s.includes("brief.md")) && sums.some((s) => s.includes("research.md")) && sums.some((s) => s.includes("plan/plan.md")), sums.join("|"));
});

test("paragraph line breaks are kept and citations link to the cited anchor", () => {
  const { html, text } = exampleIntentGate();
  assert.ok(/^F2 KNOW/m.test(text), "research findings stay on their own lines");
  assert.match(html, /<a href="#doc-research-md-f2"[^>]*>research\.md#F2<\/a>/);
  assert.ok(html.includes('id="doc-research-md-f2"'));
  assert.match(html, /<a href="#doc-brief-md-acceptance-criteria"[^>]*>brief\.md#acceptance-criteria<\/a>/);
});

test("a citation whose anchor does not exist stays plain text", () => {
  const { html } = openGate({
    ticket: "octo/repo#8",
    files: {
      "brief.md": "# Brief\n\n## Goal\nDo it [research.md#nowhere].\n\n## Acceptance criteria\n- [ ] x\n",
      "research.md": "# Research\n\n## Findings\nF1 KNOW a thing\n",
      "access-report.json": [],
    },
    decisions: [{ id: "D-001", raised_by: "plan", blocks: ["implement"], question: "Go?", options: ["yes", "no"], status: "pending" }],
    gate: "D-001",
  });
  assert.ok(html.includes("research.md#nowhere"));
  assert.ok(!html.includes('href="#doc-research-md-nowhere"'));
});

test("the page passes the curator artifact check, in the example and the demo fixture", () => {
  checkPasses(exampleIntentGate().file);
  const demo = openGate({
    ticket: "acme/widgets#1",
    files: {
      "brief.md": { from: join(DEMO, "brief.md") },
      "research.md": { from: join(DEMO, "research.md") },
      "access-report.json": { from: join(DEMO, "access-report.json") },
      "plan/plan.md": { from: join(DEMO, "plan.md") },
    },
    decisions: [
      { id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Should a Retry-After of 0 still count against the attempt cap?", options: ["yes", "no"], status: "answered", answer: "yes", answered_by: "human", answered_at: "2026-10-21T06:33:54Z" },
      { id: "D-002", gate: "intent", raised_by: "engine", blocks: ["implement"], question: "Does this plan do what the brief asks, and nothing it does not ask for?", options: ["approve", "revise"], context: "plan/plan.md", status: "pending" },
    ],
    gate: "intent",
  });
  checkPasses(demo.file);
  assert.match(demo.text.split("\n")[0], /^You are deciding whether the plan for acme\/widgets#1 is ready to implement/);
  assert.ok(demo.html.indexOf("Redelivery honours") < firstRawDetails(demo.html));
  assert.ok(demo.html.indexOf('id="access"') > demo.html.indexOf("data-plan-question="), "access is background, after the decision");
  assert.ok(!/^(#|\||\[ \]|\{")/m.test(demo.text));
});

test("a ship-stage decision explains the push and draft PR, and may show the recheck", () => {
  const { text } = openGate({
    ticket: "Amanborn007/detent-demo#1",
    files: EXAMPLE_FILES,
    decisions: [{ id: "D-009", raised_by: "ship", blocks: ["ship"], question: "No reviewer socket is declared. How to proceed?", options: ["accept the agent's own review", "wire a reviewer socket first"], status: "pending" }],
    gate: "D-009",
  });
  assert.match(text.split("\n")[0], /^You are deciding whether/);
  assert.ok(/push the branch and open a draft pull request/i.test(text));
  assert.ok(text.includes("Step verdicts"), "recheck.md is at or before the ship stage");
});

test("a brief with no Goal and a plan with non-standard headings show a notice, the raw file open, and a warning event", () => {
  const { ctx, html, text } = openGate({
    ticket: "octo/repo#9",
    files: {
      "brief.md": "# Brief: octo/repo#9\n\nMake the retry faster, see the ticket. BRIEF-FREE-TEXT\n",
      "research.md": "# Research\n\n## Findings\nF1 KNOW a thing\n",
      "access-report.json": [],
      "plan/plan.md": "# Plan\n\n## Overview\nPLAN-FREE-TEXT first do this.\n\n1. a step under no steps heading\n",
    },
    decisions: [{ id: "D-001", gate: "intent", raised_by: "engine", blocks: ["implement"], question: "Intent gate: faithful?", options: ["approve", "revise"], status: "pending" }],
    gate: "intent",
  });
  assert.ok(text.includes("brief.md has no ## Goal section; the raw file is shown below"));
  assert.ok(text.includes("plan/plan.md has no ## Steps section; the raw file is shown below"));
  for (const [name, marker] of [["brief.md", "BRIEF-FREE-TEXT"], ["plan/plan.md", "PLAN-FREE-TEXT"]]) {
    const re = new RegExp(`<details open[^>]*>\\s*<summary[^>]*>${name.replace("/", "\\/")}`);
    assert.match(html, re, `${name} is shown un-collapsed`);
    assert.ok(text.includes(marker));
  }
  assert.ok(html.includes('data-plan-question="D-001"'), "the gate is not blank");
  const warns = eventsOf(ctx.runDir).filter((e) => e.event === "warning" && e.code === "gate_page_section_missing");
  assert.ok(warns.some((w) => w.file === "brief.md" && w.section === "## Goal"), JSON.stringify(warns));
  assert.ok(warns.some((w) => w.file === "plan/plan.md" && w.section === "## Steps"), JSON.stringify(warns));
});

test("a well-formed run raises no gate page warning", () => {
  const { ctx } = exampleIntentGate();
  assert.deepEqual(eventsOf(ctx.runDir).filter((e) => e.event === "warning" && /^gate_page_/.test(e.code || "")), []);
});

test("an unreadable access report fails loudly on the page instead of vanishing", () => {
  const { html, text, ctx } = openGate({
    ticket: "octo/repo#10",
    files: {
      "brief.md": "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] x\n",
      "research.md": "# R\n",
      "access-report.json": "{not json",
      "plan/plan.md": "# Plan\n\n## Steps\n1. s. Files: `a`. Verify: `t`.\n\n## Risks\n- r\n",
    },
    decisions: [{ id: "D-001", gate: "intent", raised_by: "engine", blocks: ["implement"], question: "Faithful?", options: ["approve", "revise"], status: "pending" }],
    gate: "intent",
  });
  assert.ok(text.includes("access-report.json could not be read as JSON"));
  assert.ok(html.includes("{not json"));
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "warning" && e.file === "access-report.json"));
});
