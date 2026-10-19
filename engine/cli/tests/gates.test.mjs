import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engine, mkRun, writeArtifact, readJson, writeJson, throughResearch, eventsOf } from "./helpers.mjs";

function toPlanEnd(ctx) {
  throughResearch(ctx);
  let r = engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  return engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
}

test("plan end raises the intent gate and refuses until it is answered", () => {
  const ctx = mkRun();
  let r = toPlanEnd(ctx);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /intent/i);
  assert.match(r.json.next_step, /engine gate open intent/);
  // gate decision appended, pending, blocks implement
  const decisions = readJson(join(ctx.runDir, "decisions.json"));
  const gate = decisions.find((d) => d.gate === "intent");
  assert.ok(gate, "intent gate decision appended");
  assert.equal(gate.status, "pending");
  assert.ok(gate.blocks.includes("implement"));
  assert.match(gate.id, /^D-\d+$/);
  // plan is blocked on it (structured blocked_on, per CONTRACT.md)
  const status = readJson(join(ctx.runDir, "stage-status.json"));
  assert.equal(status.stages.plan.status, "blocked");
  assert.deepEqual(status.stages.plan.blocked_on, [gate.id]);

  // second end attempt: still refused, no duplicate gate decision
  r = engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  const decisions2 = readJson(join(ctx.runDir, "decisions.json"));
  assert.equal(decisions2.filter((d) => d.gate === "intent").length, 1);

  // human answers (curator stand-in: hand-edit decisions.json)
  const answered = decisions2.map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d);
  writeJson(join(ctx.runDir, "decisions.json"), answered);
  r = engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(readJson(join(ctx.runDir, "stage-status.json")).stages.plan.status, "done");
});

test("gate open renders a terminal fallback when curator is not on PATH", () => {
  const ctx = mkRun();
  toPlanEnd(ctx); // raises the gate
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: "/usr/bin:/bin" } }); // no curator here
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.mode, "terminal_fallback");
  assert.ok(r.json.decision.question, "renders the question");
  assert.match(r.json.next_step, /decisions\.json/);
  // gate artifact written for curator to pick up later
  const gateFiles = r.json.gate_artifact;
  assert.ok(existsSync(gateFiles), "gate artifact exists: " + gateFiles);
  const artifact = readJson(gateFiles);
  assert.equal(artifact.run_id, ctx.runId);
  assert.equal(artifact.stage, "plan");
  assert.equal(artifact.playbook, "plan-review");
  assert.match(artifact.artifact_path, /plan\/plan\.md$/);
});

test("gate open dispatches to curator when it is on PATH (by contract, never vendored)", () => {
  const ctx = mkRun();
  toPlanEnd(ctx);
  // stub curator binary on PATH
  const binDir = join(tmpdir(), "engine-test-bin-" + process.pid);
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "curator");
  writeFileSync(stub, "#!/bin/sh\necho stub-curator\n");
  chmodSync(stub, 0o755);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: binDir + ":/usr/bin:/bin" } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.mode, "curator");
  assert.match(r.json.next_step, /curator open/);
  assert.match(r.json.next_step, /curator await/);
});

test("gate open on an unknown gate id exits 2", () => {
  const ctx = mkRun();
  const r = engine(["gate", "open", "D-999", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});

test("gate open on an already-answered gate reports it and points at stage end", () => {
  const ctx = mkRun();
  toPlanEnd(ctx);
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0);
  assert.equal(r.json.decision.status, "answered");
  assert.match(r.json.next_step, /engine stage end plan/);
});

test("stage begin refuses while a pending decision blocks that stage", () => {
  const ctx = mkRun();
  toPlanEnd(ctx);
  // approve the intent gate so plan can end
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  // a stage raised an open question that blocks implement
  const decisions = readJson(p);
  decisions.push({
    id: "D-090", raised_by: "research", blocks: ["implement"],
    question: "Reuse lib/retry.ts or write new?", options: ["reuse", "new"], status: "pending",
  });
  writeJson(p, decisions);
  let r = engine(["stage", "begin", "implement", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /D-090/);
  assert.match(r.json.next_step, /engine gate open D-090/);
  const status = readJson(join(ctx.runDir, "stage-status.json"));
  assert.equal(status.stages.implement.status, "blocked");
  assert.deepEqual(status.stages.implement.blocked_on, ["D-090"]);
  // answer it -> begin succeeds
  writeJson(p, readJson(p).map((d) => d.id === "D-090"
    ? { ...d, status: "answered", answer: "reuse", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
  r = engine(["stage", "begin", "implement", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
});

test("full tail: implement -> recheck -> ship -> respond transitions, events recorded", () => {
  const ctx = mkRun();
  toPlanEnd(ctx);
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  for (const s of ["implement", "recheck", "ship", "respond"]) {
    assert.equal(engine(["stage", "begin", s, "--repo", ctx.repo, "--run", ctx.runId]).code, 0, "begin " + s);
    // implement records a tdd exemption (no behavior change in this smoke
    // test); recheck needs its required artifact before it can end.
    const endArgs = s === "implement" ? ["--tdd-exempt", "no behavior change in this transition smoke test"] : [];
    if (s === "recheck") writeArtifact(ctx.runDir, "recheck.md", "# recheck\n");
    assert.equal(engine(["stage", "end", s, "--repo", ctx.repo, "--run", ctx.runId, ...endArgs]).code, 0, "end " + s);
  }
  const r = engine(["next", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0);
  assert.equal(r.json.stage, null);
  assert.match(r.json.next_step, /complete/i);
  const gateEvents = eventsOf(ctx.runDir).filter((e) => e.event === "gate_raised");
  assert.equal(gateEvents.length, 1);
});
