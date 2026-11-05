import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engine, mkRun, writeArtifact, readJson, writeJson, throughResearch } from "./helpers.mjs";

const CURATOR_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "curator", "cli.mjs");
const BARE_PATH = "/usr/bin:/bin";

function atPlanGate() {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
  const open = () => {
    const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: BARE_PATH } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    return r.json.html;
  };
  const html = open();
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  return { ctx, gate, html, open };
}

function curator(args) {
  const r = spawnSync(process.execPath, [CURATOR_CLI, ...args], {
    encoding: "utf8", env: { ...process.env, CURATOR_STATE_DIR: mkdtempSync(join(tmpdir(), "rerender-state-")), CURATOR_NO_BROWSER: "1" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

function marked({ html, gate }) {
  curator(["log", html, "-m", "decided to split step 3"]);
  curator(["answer", html, "--question", gate.id, "--answer", "approve", "--note", "ok with caveat"]);
}

test("gate open with unchanged decisions and inputs leaves the page, and its curator marks, alone", () => {
  const g = atPlanGate();
  marked(g);
  const before = readFileSync(g.html, "utf8");
  g.open();
  assert.equal(readFileSync(g.html, "utf8"), before);
  assert.match(before, /data-curator-log-entry/);
  assert.match(before, /data-curator-answered="approve"/);
});

test("a changed option re-renders the page and carries the log entries and stamps forward", () => {
  const g = atPlanGate();
  marked(g);
  const p = join(g.ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => (d.id === g.gate.id ? { ...d, options: [...d.options, "defer"] } : d)));
  g.open();
  const html = readFileSync(g.html, "utf8");
  assert.match(html, /data-plan-option="defer"/);
  assert.match(html, /decided to split step 3/);
  assert.match(html, /data-curator-answered="approve"/);
  assert.match(html, /data-curator-answered-note="ok with caveat"/);
  assert.match(html, /data-plan-option="approve"[^>]*data-curator-answered-option|data-curator-answered-option[^>]*data-plan-option="approve"/);
});

test("a stamp for an option that no longer exists is dropped, the log is kept", () => {
  const g = atPlanGate();
  marked(g);
  const p = join(g.ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => (d.id === g.gate.id ? { ...d, options: ["revise", "defer"] } : d)));
  g.open();
  const html = readFileSync(g.html, "utf8");
  assert.doesNotMatch(html, /data-curator-answered="approve"/);
  assert.match(html, /decided to split step 3/);
});

test("changed stage artifact text re-renders the page", () => {
  const g = atPlanGate();
  marked(g);
  writeArtifact(g.ctx.runDir, "plan/plan.md", "# plan\n\nnow with a new section\n");
  g.open();
  const html = readFileSync(g.html, "utf8");
  assert.match(html, /now with a new section/);
  assert.match(html, /decided to split step 3/);
});
