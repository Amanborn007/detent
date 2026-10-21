import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, } from "node:os";
import { fileURLToPath } from "node:url";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, throughResearch, eventsOf } from "./helpers.mjs";

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
  const noCurator = mkdtempSync(join(tmpdir(), "no-curator-"));
  mkCuratorClone(noCurator, null);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: "/usr/bin:/bin", TEST_CLONE: noCurator } }); // no bundled curator in this clone
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
  const binDir = mkdtempSync(join(tmpdir(), "engine-test-bin-"));
  mkCuratorClone(binDir, `#!${process.execPath}\nconsole.log("stub-curator");\n`);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: "/usr/bin:/bin", TEST_CLONE: binDir } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.mode, "curator");
  assert.match(r.json.next_step, /curator open/);
  assert.match(r.json.next_step, /engine gate collect --run /);
  assert.doesNotMatch(r.json.next_step, /curator await|--playbook|curator poll/);
  assert.ok(existsSync(r.json.html), "gate html rendered for curator open");
});

test("gate open next_step uses only subcommands and flags the real curator CLI accepts", () => {
  const cliSrc = readFileSync(
    join(fileURLToPath(import.meta.url), "..", "..", "..", "curator", "cli.mjs"), "utf8");
  const real = new Set(
    cliSrc.match(/const commands = \{([^}]*)\}/)[1].split(",").map((e) => e.split(":")[0].trim()));
  const flags = new Set([...cliSrc.matchAll(/'(--[a-z-]+)':/g)].map((m) => m[1]));
  assert.ok(real.has("open") && real.has("drain") && !real.has("await"), [...real].join());

  const ctx = mkRun();
  toPlanEnd(ctx);
  const binDir = mkdtempSync(join(tmpdir(), "engine-test-bin-real-"));
  mkCuratorClone(binDir, `#!${process.execPath}\nconsole.log("stub-curator");\n`);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId],
    { env: { PATH: "/usr/bin:/bin", TEST_CLONE: binDir } });
  assert.equal(r.json.mode, "curator");

  const calls = [...r.json.next_step.matchAll(/\bcurator ([a-z-]+)((?: [^\s&;]+)*)/g)];
  assert.ok(calls.length >= 1, r.json.next_step);
  for (const [, sub, rest] of calls) {
    assert.ok(real.has(sub), `curator ${sub} is not a real curator command`);
    for (const tok of rest.split(" ").filter((t) => t.startsWith("-"))) {
      assert.ok(flags.has(tok), `curator ${sub} ${tok}: flag is not accepted by curator`);
    }
  }
  assert.match(r.json.next_step, /engine gate collect --run /);
  assert.doesNotMatch(r.json.next_step, /--playbook|curator await|curator poll/);
  // curator open takes a self-contained .html artifact, never the gate-request .json
  const opened = r.json.next_step.match(/curator open (\S+)/)[1];
  assert.match(opened, /\.html$/);
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
    cause: "judgment",
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

test("a judgment-cause decision answered 'proceed degraded' still blocks, no cause earns a bypass string", () => {
  const ctx = mkRun();
  toPlanEnd(ctx);
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  const decisions = readJson(p);
  decisions.push({
    id: "D-095", raised_by: "research", blocks: ["implement"], cause: "judgment",
    question: "Retry forever or cap at N?", status: "answered",
    answer: "proceed degraded (accept degraded confidence)", answered_by: "human",
    answered_at: new Date().toISOString(),
  });
  writeJson(p, decisions);
  const r = engine(["stage", "begin", "implement", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, "the proceed-degraded string is not a judgment override");
  assert.match(r.json.reason, /D-095/);
  assert.match(r.json.next_step, /engine gate open D-095/);
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

test("stage end refuses while a decision blocking that stage is pending", () => {
  const ctx = mkRun();
  let r = engine(["stage", "begin", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  writeJson(join(ctx.runDir, "decisions.json"), [
    { id: "D-001", raised_by: "agent", blocks: ["intake"], question: "which?", options: ["a", "b"], status: "pending" },
  ]);
  r = engine(["stage", "end", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /D-001/);
  assert.match(r.json.next_step, /engine gate open/);
});
