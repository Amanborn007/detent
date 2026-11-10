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
const words = (s) => (s.match(/\S+/g) || []).length;

function intentGate() {
  const ctx = mkRun({ ticket: "Amanborn007/detent-demo#1" });
  for (const [rel, src] of [["brief.md", "brief.md"], ["research.md", "research.md"], ["access-report.json", "access-report.json"],
    ["plan/plan.md", "plan/plan.md"], ["recheck.md", "recheck.md"]]) {
    mkdirSync(dirname(join(ctx.runDir, rel)), { recursive: true });
    copyFileSync(join(EXAMPLE, src), join(ctx.runDir, rel));
  }
  writeArtifact(ctx.runDir, "ticket.json", "{}");
  const decisions = readJson(join(EXAMPLE, "decisions.json")).map((d) => {
    if (d.id !== "D-003") return d;
    const { answer, answered_by, answered_at, ...rest } = d;
    return { ...rest, status: "pending" };
  });
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-options-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: BARE_PATH, TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return { ctx, html: readFileSync(r.json.html, "utf8") };
}

const card = (html, opt) => new RegExp(`<div[^>]*data-plan-option="${opt}"[^>]*>([\\s\\S]*?)</div>`).exec(html)[1];

test("the intent cards keep approve/revise values and read as decisions", () => {
  const { html } = intentGate();
  for (const [opt, label] of [["approve", "Approve the plan"], ["revise", "Send it back"]]) {
    const c = card(html, opt);
    assert.match(c, new RegExp(`<strong>${label}</strong>`));
    const conseq = /<p[^>]*data-plan-consequence[^>]*>([\s\S]*?)<\/p>/.exec(c)[1];
    assert.ok(words(conseq) >= 4, `${opt} consequence: ${conseq}`);
  }
  assert.match(card(html, "approve"), /Unlocks implementation/);
});

test("a curator answer of approve still records as answered", () => {
  const { ctx } = intentGate();
  const f = join(mkdtempSync(join(tmpdir(), "gate-page-options-fb-")), "fb.json");
  const intent = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.id === "D-003");
  writeJson(f, [{ type: "decision", question: intent.id, answer: "approve" }]);
  const r = engine(["gate", "collect", "--run", ctx.runId, "--file", f], { env: { PATH: BARE_PATH } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const after = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.id === "D-003");
  assert.equal(after.status, "answered");
  assert.equal(after.answer, "approve");
});
