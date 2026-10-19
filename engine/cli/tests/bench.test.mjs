// End-to-end wiring test for `engine bench` and the gate-timing events it
// depends on. Proves the CLI emits gate_opened (at gate open) and gate_answered
// (when it observes a human answer), and that `engine bench` derives the
// benchmark, writes benchmark.json, and appends the ledger. The arithmetic of
// each metric is proven in engine/bench/test/bench.test.mjs against a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engine, mkRun, writeArtifact, readJson, writeJson, throughResearch, eventsOf, detentHome } from "./helpers.mjs";

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("engine bench: gate_opened/gate_answered emitted, benchmark.json + ledger written, effective-time math holds", () => {
  const ctx = mkRun();
  throughResearch(ctx);

  // Drive plan to raise the intent gate.
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2); // raises + refuses

  // Open the gate -> emits gate_opened.
  const open = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: "/usr/bin:/bin" } });
  assert.equal(open.code, 0, open.stdout);
  assert.ok(eventsOf(ctx.runDir).some((e) => e.event === "gate_opened" && e.gate === "intent"), "gate_opened emitted");

  // Human answers (curator stand-in). Sleep >1s so the answer lands in a later
  // second than the open (event ts is second-resolution) => a measurable wait.
  sleepMs(1100);
  const p = join(ctx.runDir, "decisions.json");
  writeJson(p, readJson(p).map((d) => d.gate === "intent"
    ? { ...d, status: "answered", answer: "approve", answered_by: "human", answered_at: new Date().toISOString() }
    : d));

  // Ending plan observes the answer -> emits gate_answered.
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  const answered = eventsOf(ctx.runDir).filter((e) => e.event === "gate_answered" && e.decision_id === "D-001");
  assert.equal(answered.length, 1, "exactly one gate_answered for D-001");
  assert.equal(answered[0].answer, "approve");
  assert.ok(answered[0].answered_at, "carries the human answered_at");

  // Re-running does not duplicate the gate_answered event (idempotent).
  engine(["next", "--repo", ctx.repo, "--run", ctx.runId]);
  assert.equal(eventsOf(ctx.runDir).filter((e) => e.event === "gate_answered" && e.decision_id === "D-001").length, 1);

  // engine bench: compute + write + append.
  const bench = engine(["bench", ctx.runId, "--repo", ctx.repo]);
  assert.equal(bench.code, 0, bench.stdout);
  assert.equal(bench.json.run_id, ctx.runId);

  const benchmark = readJson(join(ctx.runDir, "benchmark.json"));
  assert.equal(benchmark.schema, "detent-benchmark-v1");
  // Phases timed from stage_begin/stage_end.
  assert.ok(benchmark.phases.intake && benchmark.phases.intake.wall_ms >= 0);
  assert.ok(benchmark.phases.plan && benchmark.phases.plan.status === "done");
  // Gate wait measured (>= the 1s we slept) and one gate observed.
  assert.equal(benchmark.gates.count, 1);
  assert.ok(benchmark.human_gate_wait_ms >= 1000, "gate wait >= 1s: " + benchmark.human_gate_wait_ms);
  // No token stream -> honest "unrecorded".
  assert.equal(benchmark.tokens.recorded, false);
  // The defining identity holds end-to-end.
  assert.equal(
    benchmark.effective_agentic_time_ms,
    benchmark.wall_clock_ms - benchmark.human_gate_wait_ms - benchmark.async_external_wait_ms,
  );

  // Ledger appended under <DETENT_ROOT>/benchmarks/ledger.jsonl.
  const ledger = join(detentHome(), "benchmarks", "ledger.jsonl");
  assert.ok(existsSync(ledger), "ledger written: " + ledger);
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  const summary = JSON.parse(lines[lines.length - 1]);
  assert.equal(summary.run_id, ctx.runId);
  assert.equal(summary.effective_agentic_time_ms, benchmark.effective_agentic_time_ms);
});

test("parking on a human gate auto-writes a partial benchmark checkpoint (before the wait), and gate open adds another", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");

  // stage end raises the intent gate and refuses (run parks on the human).
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);

  // A partial benchmark now exists — WITHOUT waiting for the human answer.
  const bmPath = join(ctx.runDir, "benchmark.json");
  assert.ok(existsSync(bmPath), "benchmark.json written at park time");
  const bm = readJson(bmPath);
  assert.equal(bm.partial, true, "checkpoint is marked partial");
  assert.match(bm.checkpoint.reason, /^gate-pending:intent/);
  // The impending human wait is not counted yet (no answered gate on the timeline).
  assert.equal(bm.human_gate_wait_ms, 0);

  const setPath = join(ctx.runDir, "benchmark-checkpoints.jsonl");
  assert.equal(readFileSync(setPath, "utf8").trim().split("\n").length, 1, "one checkpoint in the set");

  // Opening the gate for the human is a distinct park moment -> a second checkpoint.
  assert.equal(engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: "/usr/bin:/bin" } }).code, 0);
  assert.equal(readFileSync(setPath, "utf8").trim().split("\n").length, 2, "gate open adds a checkpoint");

  // The global ledger carries the partial line so the whole set is captured centrally.
  const ledger = readFileSync(join(detentHome(), "benchmarks", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(ledger.some((l) => l.run_id === ctx.runId && l.partial === true), "partial ledger line present");
});

test("engine bench --checkpoint writes a partial benchmark on demand (for skills that park on their own async gate)", () => {
  const ctx = mkRun();
  throughResearch(ctx);
  const r = engine(["bench", ctx.runId, "--repo", ctx.repo, "--checkpoint", "--reason", "external-signoff:deliveries", "--gate", "D-042"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.checkpoint, true);
  const bm = readJson(join(ctx.runDir, "benchmark.json"));
  assert.equal(bm.partial, true);
  assert.equal(bm.checkpoint.reason, "external-signoff:deliveries");
  assert.equal(bm.checkpoint.gate_id, "D-042");
});

test("engine bench refuses an unknown run id (exit 2)", () => {
  mkRun(); // establishes a home
  const r = engine(["bench", "nope-not-a-run"]);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /no run/);
});
