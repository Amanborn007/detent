import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { engine, mkRepo, mkRun, writeArtifact, readJson, throughResearch, eventsOf, detentHome } from "./helpers.mjs";

test("run new creates .sdlc/<run-id>/ with run.json + stage-status.json (intake pending)", () => {
  const repo = mkRepo();
  const r = engine(["run", "new", "--ticket", "octo/repo#1", "--slug", "retry-webhooks", "--repo", repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.match(r.json.run_id, /^\d{4}-\d{2}-\d{2}-octo-repo-1-retry-webhooks$/);
  assert.ok(r.json.next_step, "next_step present");
  // run state is centralized under the detent home, not the work repo
  const runDir = join(detentHome(), ".sdlc", r.json.run_id);
  const runJson = readJson(join(runDir, "run.json"));
  assert.equal(runJson.ticket_ref, "octo/repo#1");
  assert.equal(runJson.run_id, r.json.run_id);
  assert.ok(runJson.created_at);
  const status = readJson(join(runDir, "stage-status.json"));
  assert.equal(status.run_id, r.json.run_id);
  assert.equal(status.stages.intake.status, "pending");
  for (const s of ["intake", "research", "plan", "implement", "recheck", "ship", "respond"]) {
    assert.equal(status.stages[s].status, "pending", `stage ${s} pending`);
  }
  assert.deepEqual(readJson(join(runDir, "decisions.json")), []);
  const events = eventsOf(runDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "run_created");
});

test("run new refuses a duplicate run-id (immutable run dirs)", () => {
  const repo = mkRepo();
  const a = engine(["run", "new", "--ticket", "octo/repo#1", "--slug", "x", "--repo", repo]);
  assert.equal(a.code, 0);
  const b = engine(["run", "new", "--ticket", "octo/repo#1", "--slug", "x", "--repo", repo]);
  assert.equal(b.code, 2);
  assert.equal(b.json.ok, false);
  assert.ok(b.json.reason, "structured reason present");
});

test("run new without --ticket exits 2", () => {
  const r = engine(["run", "new", "--repo", mkRepo()]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});

test("stage begin refuses an illegal jump (research before intake done)", () => {
  const ctx = mkRun();
  const r = engine(["stage", "begin", "research", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /intake/);
  assert.ok(r.json.next_step);
});

test("stage begin refuses an unknown stage", () => {
  const ctx = mkRun();
  const r = engine(["stage", "begin", "deploy", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /unknown stage/i);
});

test("stage end refuses a stage that was never begun", () => {
  const ctx = mkRun();
  const r = engine(["stage", "end", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /not in_progress|never begun|pending/i);
});

test("stage end refuses when the required artifact is missing", () => {
  const ctx = mkRun();
  let r = engine(["stage", "begin", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0);
  r = engine(["stage", "end", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /brief\.md/);
  // artifact appears -> end succeeds
  writeArtifact(ctx.runDir, "brief.md");
  r = engine(["stage", "end", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0, r.stdout);
  const status = readJson(join(ctx.runDir, "stage-status.json"));
  assert.equal(status.stages.intake.status, "done");
  assert.equal(status.stages.intake.artifact, "brief.md");
});

test("stage begin refuses a stage that is already done", () => {
  const ctx = mkRun();
  engine(["stage", "begin", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  writeArtifact(ctx.runDir, "brief.md");
  engine(["stage", "end", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  const r = engine(["stage", "begin", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /done/);
});

test("legal chain intake -> research works and appends events", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  const status = readJson(join(ctx.runDir, "stage-status.json"));
  assert.equal(status.stages.intake.status, "done");
  assert.equal(status.stages.research.status, "done");
  const events = eventsOf(ctx.runDir);
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, ["run_created", "stage_begin", "stage_end", "stage_begin", "stage_end"]);
  for (const e of events) { assert.ok(e.ts, "every event has ts"); }
  const stageEvents = events.filter((e) => e.event.startsWith("stage_"));
  assert.deepEqual(stageEvents.map((e) => e.stage), ["intake", "intake", "research", "research"]);
});

test("engine next reports current stage and the exact next command", () => {
  const ctx = mkRun();
  let r = engine(["next", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.code, 0);
  assert.equal(r.json.stage, "intake");
  assert.equal(r.json.status, "pending");
  assert.match(r.json.next_step, /engine stage begin intake/);
  engine(["stage", "begin", "intake", "--repo", ctx.repo, "--run", ctx.runId]);
  r = engine(["next", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(r.json.stage, "intake");
  assert.equal(r.json.status, "in_progress");
  assert.match(r.json.next_step, /brief\.md/); // artifact missing -> says what to produce
  writeArtifact(ctx.runDir, "brief.md");
  r = engine(["next", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.match(r.json.next_step, /engine stage end intake/);
});

test("commands refuse when no run exists", () => {
  const repo = mkRepo();
  const r = engine(["next", "--repo", repo]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
});
