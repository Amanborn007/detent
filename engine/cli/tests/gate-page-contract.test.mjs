import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, eventsOf } from "./helpers.mjs";
import { contractWarnings } from "../gate-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const EXAMPLE = join(REPO, "docs", "examples", "2026-10-20-amanborn007-detent-demo-1");
const DEMO = join(REPO, "docs", "demo", "fixtures");
const NEW_QUESTION = "Does this plan do what the brief asks, and nothing it does not ask for?";

function openGate({ ticket, files, decisions, gate }) {
  const ctx = mkRun({ ticket });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ctx.runDir, rel)), { recursive: true });
    if (content.from) copyFileSync(content.from, join(ctx.runDir, rel));
    else writeArtifact(ctx.runDir, rel, typeof content === "string" ? content : JSON.stringify(content));
  }
  writeJson(join(ctx.runDir, "decisions.json"), decisions);
  const cdir = mkdtempSync(join(tmpdir(), "gate-page-contract-"));
  mkCuratorClone(cdir, `#!${process.execPath}\nconsole.log(JSON.stringify({ url: "http://127.0.0.1:9/s/abc", key: process.argv[3] }));\n`);
  const r = engine(["gate", "open", gate, "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: "/usr/bin:/bin", TEST_CLONE: cdir, CURATOR_NO_BROWSER: "1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const contract = eventsOf(ctx.runDir).filter((e) => e.event === "warning" && String(e.code).startsWith("gate_page_contract"));
  return { html: readFileSync(r.json.html, "utf8"), contract };
}

const exampleDecisions = () => readJson(join(EXAMPLE, "decisions.json")).map((d) => {
  if (d.id !== "D-003") return d;
  const { answer, answered_by, answered_at, ...rest } = d;
  return { ...rest, status: "pending" };
});

test("the example intent gate raises no contract warning", () => {
  const { contract } = openGate({
    ticket: "Amanborn007/detent-demo#1",
    files: {
      "brief.md": { from: join(EXAMPLE, "brief.md") },
      "research.md": { from: join(EXAMPLE, "research.md") },
      "access-report.json": { from: join(EXAMPLE, "access-report.json") },
      "plan/plan.md": { from: join(EXAMPLE, "plan", "plan.md") },
      "recheck.md": { from: join(EXAMPLE, "recheck.md") },
    },
    decisions: exampleDecisions(),
    gate: "intent",
  });
  assert.deepEqual(contract, []);
});

test("the demo fixture intent gate raises no contract warning", () => {
  const { contract } = openGate({
    ticket: "acme/widgets#1",
    files: {
      "brief.md": { from: join(DEMO, "brief.md") },
      "research.md": { from: join(DEMO, "research.md") },
      "access-report.json": { from: join(DEMO, "access-report.json") },
      "plan/plan.md": { from: join(DEMO, "plan.md") },
    },
    decisions: [
      { id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Should a Retry-After of 0 still count against the attempt cap?", options: ["yes", "no"], status: "answered", answer: "yes", answered_by: "human", answered_at: "2026-10-21T06:33:54Z" },
      { id: "D-002", gate: "intent", raised_by: "engine", blocks: ["implement"], question: NEW_QUESTION, options: ["approve", "revise"], context: "plan/plan.md", status: "pending" },
    ],
    gate: "intent",
  });
  assert.deepEqual(contract, []);
});

test("a D-00x gate with bare string options warns C5 and C6 for each option, and none with option_details", () => {
  const files = { "brief.md": "# Brief: octo/repo#7\n\n## Goal\nDo the thing the ticket asks for.\n\n## Acceptance criteria\n- [ ] done\n" };
  const base = { id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", options: ["a", "b"], status: "pending" };
  const bare = openGate({ ticket: "octo/repo#7", files, decisions: [base], gate: "D-001" }).contract;
  for (const o of ["a", "b"]) {
    for (const c of ["C5", "C6"]) assert.ok(bare.some((w) => w.check === c && w.detail.includes(`"${o}"`)), `${c} ${o}: ${JSON.stringify(bare)}`);
  }
  const details = {
    a: { label: "Take the first path", consequence: "Ships the first path to every user.", then: "Then the implement stage builds the first path." },
    b: { label: "Take the second path", consequence: "Ships the second path to every user.", then: "Then the implement stage builds the second path." },
  };
  const full = openGate({ ticket: "octo/repo#7", files, decisions: [{ ...base, option_details: details }], gate: "D-001" }).contract;
  assert.deepEqual(full, []);
});

test("a page missing data-plan-brief yields a warning event naming C1", () => {
  const { html } = openGate({
    ticket: "octo/repo#7",
    files: { "brief.md": "# Brief\n\n## Goal\nG.\n\n## Acceptance criteria\n- [ ] done\n" },
    decisions: [{ id: "D-001", raised_by: "intake", blocks: ["implement"], question: "Which one?", options: ["a", "b"], status: "pending" }],
    gate: "D-001",
  });
  const broken = html.replace(/ data-plan-brief/g, "");
  const ws = contractWarnings(broken);
  const c1 = ws.find((w) => w.check === "C1");
  assert.ok(c1, JSON.stringify(ws));
  assert.match(c1.code, /^gate_page_contract/);
  assert.match(c1.detail, /data-plan-brief/);
});
