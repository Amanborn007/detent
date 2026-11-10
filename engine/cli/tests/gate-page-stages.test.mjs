// The generic gate page names every stage the open decisions block, not the stage that raised them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { engine, mkCuratorClone, mkRun, writeArtifact, writeJson } from "./helpers.mjs";

const BARE_PATH = "/usr/bin:/bin";
const BRIEF = "# Brief: octo/repo#7\n\n## Goal\nDo the thing the ticket asks for.\n\n## Acceptance criteria\n- [ ] done\n";

function pageFor(blockLists) {
  const ctx = mkRun({ ticket: "octo/repo#7" });
  mkdirSync(dirname(join(ctx.runDir, "brief.md")), { recursive: true });
  writeArtifact(ctx.runDir, "brief.md", BRIEF);
  const decisions = blockLists.map((blocks, i) => ({
    id: `D-00${i + 1}`, raised_by: "intake", blocks, question: `Which way for case ${i + 1}?`, options: ["a", "b"], status: "pending",
  }));
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-stages-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", decisions[0].id, "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: BARE_PATH, TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const html = readFileSync(r.json.html, "utf8");
  return html.split('<section id="raw">')[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}

test("decisions raised at intake that block four stages name those stages, not intake", () => {
  const text = pageFor([["research", "plan", "implement", "ship"]]);
  assert.ok(!text.includes("so the intake stage can start"), text);
  assert.match(text, /research stage can start/);
  assert.match(text, /research, plan, implement and ship stages/);
  assert.match(text, /The research stage does not start until every question on this page is answered/);
});

test("a decision that blocks one stage says stage in the singular", () => {
  const text = pageFor([["implement"]]);
  assert.match(text, /The implement stage cannot start until this is answered\./);
  assert.match(text, /block the implement stage for/);
  assert.ok(!/implement stages/.test(text), text);
});

test("a decision that blocks two stages says stages in the plural", () => {
  const text = pageFor([["implement", "ship"]]);
  assert.match(text, /The implement and ship stages cannot start until this is answered\./);
});

test("stages shared by several decisions are listed once, in pipeline order", () => {
  const text = pageFor([["implement", "ship"], ["implement", "plan"]]);
  assert.match(text, /block the plan, implement and ship stages for/);
  assert.equal((text.match(/plan, implement and ship stages for/g) || []).length, 1);
  assert.match(text, /so the plan stage can start/);
});
