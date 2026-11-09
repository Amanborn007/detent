import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "..", "..", "..", "docs", "examples", "2026-10-20-amanborn007-detent-demo-1");
const BARE_PATH = "/usr/bin:/bin";
const NEW_QUESTION = "Does this plan do what the brief asks, and nothing it does not ask for?";

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const plain = (h) => unescape(h.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function openGate({ ticket, files, decisions, gate }) {
  const ctx = mkRun({ ticket });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ctx.runDir, rel)), { recursive: true });
    if (content.from) copyFileSync(content.from, join(ctx.runDir, rel));
    else writeArtifact(ctx.runDir, rel, typeof content === "string" ? content : JSON.stringify(content));
  }
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-brief-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", gate, "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: BARE_PATH, TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const html = readFileSync(r.json.html, "utf8");
  return { html, main: html.split('<section id="raw">')[0] };
}

const EXAMPLE_FILES = {
  "brief.md": { from: join(EXAMPLE, "brief.md") },
  "research.md": { from: join(EXAMPLE, "research.md") },
  "access-report.json": { from: join(EXAMPLE, "access-report.json") },
  "plan/plan.md": { from: join(EXAMPLE, "plan", "plan.md") },
};

function example() {
  const decisions = readJson(join(EXAMPLE, "decisions.json")).map((d) => {
    if (d.id !== "D-003") return d;
    const { answer, answered_by, answered_at, ...rest } = d;
    return { ...rest, status: "pending" };
  });
  return openGate({ ticket: "Amanborn007/detent-demo#1", files: EXAMPLE_FILES, decisions, gate: "intent" });
}

const briefLine = (html, key) => {
  const m = new RegExp(`<p[^>]*data-brief="${key}"[^>]*>([\\s\\S]*?)</p>`).exec(html);
  assert.ok(m, `no p[data-brief=${key}]`);
  return plain(m[1]);
};

test("the h1 is followed by a brief with four plain lines, before any decision or background", () => {
  const { main } = example();
  const h1 = main.indexOf("<h1");
  const brief = main.search(/<section[^>]*data-plan-brief/);
  const q = main.indexOf("data-plan-question=");
  assert.ok(h1 >= 0 && brief > h1 && q > brief, "h1, then the brief, then the decision");
  for (const key of ["goal", "done", "ask", "next"]) {
    const line = briefLine(main, key);
    assert.ok(line.split(" ").length >= 5, `${key}: ${line}`);
    assert.ok(!/[<>`]/.test(line), `${key} is plain text: ${line}`);
  }
  assert.ok(briefLine(main, "goal").includes("Callers can cap how long a slug gets"));
  assert.match(briefLine(main, "done"), /2 earlier decisions answered/);
  assert.ok(main.slice(0, q).indexOf("plan/plan.md") < 0, "no engine file path before the decision");
});

test("the intent decision declares itself required, pick-one, with no recommendation and a stated reason", () => {
  const { main } = example();
  const tag = /<div[^>]*data-plan-question="D-003"[^>]*>/.exec(main)[0];
  assert.match(tag, /data-plan-required/);
  assert.match(tag, /data-plan-shape="pick-one"/);
  assert.match(tag, /data-plan-no-recommendation="[^"]{10,}"/);
  assert.ok(!/data-plan-recommended/.test(tag));
  const card = main.slice(main.indexOf(tag));
  assert.match(card, /<h3[^>]*>\s*Does this plan do what the brief asks, and nothing it does not ask for\?\s*<\/h3>/);
  assert.match(card, /<p[^>]*data-plan-why-now[^>]*>[^<]{10,}<\/p>/);
  assert.ok(!/data-plan-reason/.test(card), "no reason without a recommendation");
});

test("each intent option carries a label, a consequence and a then", () => {
  const { main } = example();
  for (const [opt, label, conseq, then] of [["approve", "Approve the plan", /Unlocks implementation/, /implement stage runs the plan steps/], ["revise", "Send it back", /Sends the plan back to planning with your note/, /plan stage reruns with your note/]]) {
    const m = new RegExp(`<div[^>]*data-plan-option="${opt}"[^>]*>([\\s\\S]*?)</div>`).exec(main);
    assert.ok(m, opt);
    assert.match(m[1], new RegExp(`<strong>${label}</strong>`));
    assert.match(main, new RegExp(`data-plan-option="${opt}"`));
    const c = /<p[^>]*data-plan-consequence[^>]*>([\s\S]*?)<\/p>/.exec(m[1]);
    const t = /<p[^>]*data-plan-then[^>]*>([\s\S]*?)<\/p>/.exec(m[1]);
    assert.ok(c && conseq.test(plain(c[1])), opt);
    assert.ok(t && then.test(plain(t[1])), opt);
  }
});

test("a decision with no consequence data gets exact option strings and no invented text", () => {
  const options = ['use "quotes" & <tags>', "plain"];
  const { main } = openGate({
    ticket: "octo/repo#7",
    files: { "brief.md": "# Brief: octo/repo#7\n\n## Goal\nDo the thing the ticket asks for.\n\n## Acceptance criteria\n- [ ] done\n" },
    decisions: [{ id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", options, status: "pending" }],
    gate: "D-001",
  });
  const got = [...main.matchAll(/data-plan-option="([^"]*)"/g)].map((m) => unescape(m[1]));
  assert.deepEqual(got, options);
  assert.ok(!/data-plan-consequence|data-plan-then/.test(main));
  assert.match(/<div[^>]*data-plan-question="D-001"[^>]*>/.exec(main)[0], /data-plan-no-recommendation="[^"]+"/);
  assert.match(main, /<h3[^>]*>\s*Which one\?\s*<\/h3>/);
});

test("a decision with a recommendation names the key and gives its reason", () => {
  const { main } = openGate({
    ticket: "octo/repo#7",
    files: { "brief.md": "# Brief: octo/repo#7\n\n## Goal\nDo the thing the ticket asks for.\n\n## Acceptance criteria\n- [ ] done\n" },
    decisions: [{ id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", options: ["a", "b"], recommended: { key: "b", reason: "b keeps the old behaviour for existing callers" }, status: "pending" }],
    gate: "D-001",
  });
  const tag = /<div[^>]*data-plan-question="D-001"[^>]*>/.exec(main)[0];
  assert.match(tag, /data-plan-recommended="b"/);
  assert.ok(!/data-plan-no-recommendation/.test(tag));
  assert.match(main, /<p[^>]*data-plan-reason[^>]*>[^<]*keeps the old behaviour/);
});

test("background follows the decision: plan, earlier answers, coverage, access, then the raw artifacts", () => {
  const { html } = example();
  const at = (needle) => html.indexOf(needle);
  const order = [at("data-plan-question="), at('id="plan"'), at('id="earlier"'), at('id="cover"'), at('id="access"'), at('<section id="raw">')];
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order.join(","));
});
