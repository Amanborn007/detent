import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, writeJson, readJson, eventsOf } from "./helpers.mjs";
import { validateDecisions } from "../drive/outbox.mjs";

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

const BRIEF3 = "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] alpha widget renders correctly\n- [ ] beta export succeeds quickly\n- [ ] gamma retries stop eventually\n";
const plan = (check) => `# Plan\n\n## Steps\n1. s. Files: \`a\`. Verify: \`t\`.\n\n## Risks\n- r\n\n## Intent check\n${check}\n`;

test("a verdict stays with its own criterion when the plan rows are in a different order", () => {
  const { cover } = open({
    files: { "brief.md": BRIEF3, "research.md": "# R\n", "access-report.json": "[]",
      "plan/plan.md": plan("| Acceptance criterion | Covered by | Verdict |\n|---|---|---|\n| gamma retries stop eventually | step 3 | covered |\n| alpha widget renders correctly | step 1 | covered |\n| beta export succeeds quickly | none | MISSING |\n") },
    decisions: [INTENT],
  });
  assert.match(cover, /<td>[^<]*beta export[^<]*<\/td><td>[^<]*<\/td><td>MISSING<\/td>/);
  assert.match(cover, /<td>[^<]*alpha widget[^<]*<\/td><td>step 1<\/td><td>covered<\/td>/);
  assert.match(cover, /<td>[^<]*gamma retries[^<]*<\/td><td>step 3<\/td><td>covered<\/td>/);
});

test("an Intent check note with no table shows the note and the criteria checklist, not a table", () => {
  const { cover } = open({
    files: { "brief.md": BRIEF3, "research.md": "# R\n", "access-report.json": "[]",
      "plan/plan.md": plan("intent check: skipped in drive mode. A human reviews the plan against the brief at the gate.") },
    decisions: [INTENT],
  });
  assert.match(cover, /skipped in drive mode/);
  assert.ok(!/<table/.test(cover) && !/not checked/.test(cover), cover);
  for (const c of ["alpha widget renders correctly", "beta export succeeds quickly", "gamma retries stop eventually"]) assert.ok(cover.includes(c), c);
});

test("context_excerpt renders as markdown under the question; a bare context becomes a Context line", () => {
  const { decide } = open({
    files: { "brief.md": BRIEF3 },
    gate: "D-002",
    decisions: [
      { id: "D-002", raised_by: "plan", blocks: ["implement"], question: "Which one?", options: ["a", "b"], context_excerpt: "The brief says **retry** twice.", status: "pending" },
      { id: "D-003", raised_by: "plan", blocks: ["implement"], question: "Which other one?", options: ["a", "b"], context: "notes/plan.md line 4", status: "pending" },
    ],
  });
  assert.match(decide, /<strong>retry<\/strong> twice/);
  assert.match(decide, /Context:[^<]*notes\/plan\.md line 4/);
});

test("the intent gate does not show plan/plan.md as its context", () => {
  const { decide } = open({ files: { "brief.md": BRIEF3, "plan/plan.md": plan("none") }, decisions: [INTENT] });
  assert.ok(!decide.includes("plan/plan.md"), decide);
});

test("the brief's Done so far carries the coverage summary, and omits it when there is no table", () => {
  const files = { "brief.md": { from: join(EXAMPLE, "brief.md") }, "research.md": { from: join(EXAMPLE, "research.md") }, "access-report.json": { from: join(EXAMPLE, "access-report.json") }, "plan/plan.md": { from: join(EXAMPLE, "plan", "plan.md") } };
  const ex = open({ files, decisions: readJson(join(EXAMPLE, "decisions.json")).map((d) => (d.id === "D-003" ? { ...d, status: "pending", answer: undefined, answered_by: undefined, answered_at: undefined } : d)) });
  const done = /<p data-brief="done">([\s\S]*?)<\/p>/.exec(ex.html)[1].replace(/<[^>]+>/g, "");
  assert.match(done, /The plan covers 7 of 7 criteria; step 4 is an addition, kept as D-002/);
  const none = open({ files: { "brief.md": BRIEF3, "plan/plan.md": plan("intent check: skipped in drive mode.") }, decisions: [INTENT] });
  assert.ok(!/covers \d+ of/.test(/<p data-brief="done">([\s\S]*?)<\/p>/.exec(none.html)[1]));
  assert.deepEqual(eventsOf(ex.ctx.runDir).filter((e) => e.event === "warning" && /^gate_page_contract/.test(e.code)), []);
});

test("option keys that would pollute option_details are rejected", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const r = validateDecisions([{ key: "u1", question: "Which?", blocks: ["implement"], cause: "judgment",
      options: [{ key, label: "L", consequence: "Does the first thing.", then: "Then it runs." }, { key: "b", label: "B" }] }], { stage: "plan" });
    assert.equal(r.ok, false, key);
    assert.equal(r.reason, "bad_options", key);
  }
});

test("the README names the Approve the plan and Send it back buttons", () => {
  const readme = readFileSync(join(HERE, "..", "..", "..", "README.md"), "utf8");
  assert.equal((readme.match(/Approve the plan/g) || []).length >= 2, true);
  assert.equal((readme.match(/Send it back/g) || []).length >= 2, true);
});

test("the markdown doc comment carries no review ids", () => {
  assert.ok(!readFileSync(join(HERE, "..", "markdown.mjs"), "utf8").includes("(F2, R1)"));
});
