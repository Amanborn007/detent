// liveview.test.mjs — completes the live-view MVP (roadmap #6): flip/coalescing
// semantics, incremental artifact updates, streamed answer pane, and the
// `engine live` CLI verb (one-shot + --watch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { deriveSteps, readSteps, renderLiveHtml, isRunComplete } from "../liveview.mjs";
import { engine, mkRun, readJson, writeJson, ENGINE, detentHome } from "./helpers.mjs";

function ev(obj) {
  return JSON.stringify({ ts: "2026-07-14T00:00:00Z", ...obj }) + "\n";
}

// ---------------------------------------------------------------------------
// Flip semantics
// ---------------------------------------------------------------------------

test("flip: a step's doing->done coalesces into one item, status flips", () => {
  const t1 = ev({ event: "step", stage: "implement", kind: "tool", label: "grep repo", status: "doing" });
  const before = deriveSteps(t1);
  assert.equal(before.steps.length, 1);
  assert.equal(before.steps[0].status, "doing");
  assert.equal(before.steps[0].label, "grep repo");

  const t2 = t1 + ev({ event: "step", stage: "implement", kind: "tool", label: "grep repo", status: "done" });
  const after = deriveSteps(t2);
  assert.equal(after.steps.length, 1, "still ONE item, not two rows");
  assert.equal(after.steps[0].status, "done", "flipped doing -> done");
});

test("flip: stage_begin/stage_end coalesce (doing -> done)", () => {
  const text = ev({ event: "stage_begin", stage: "research" }) + ev({ event: "stage_end", stage: "research" });
  const { steps } = deriveSteps(text);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].label, "stage: research");
});

test("flip: gate_raised/gate_answered coalesce by matching gate/decision_id label", () => {
  const text = ev({ event: "gate_raised", stage: "plan", gate: "intent", decision_id: "D-001" }) +
    ev({ event: "gate_answered", gate: "intent", decision_id: "D-001", answer: "approve" });
  const { steps } = deriveSteps(text);
  assert.equal(steps.length, 1, "gate raise+answer coalesce to one item");
  assert.equal(steps[0].status, "done");
});

test("ordering: first occurrence fixes list position even when a later item flips", () => {
  const text =
    ev({ event: "step", kind: "tool", label: "A", status: "doing" }) +
    ev({ event: "step", kind: "tool", label: "B", status: "doing" }) +
    ev({ event: "step", kind: "tool", label: "C", status: "doing" }) +
    ev({ event: "step", kind: "tool", label: "C", status: "done" });
  const { steps } = deriveSteps(text);
  assert.deepEqual(steps.map((s) => s.label), ["A", "B", "C"], "order stays A, B, C");
  assert.equal(steps.find((s) => s.label === "C").status, "done");
  assert.equal(steps.find((s) => s.label === "A").status, "doing");
});

// ---------------------------------------------------------------------------
// Honesty / no fabrication
// ---------------------------------------------------------------------------

test("honesty: empty and corrupt input yield only real events, never fabricated", () => {
  const empty = deriveSteps("");
  assert.deepEqual(empty.steps, []);
  assert.equal(empty.steps_recorded, true, "an empty (but present) log is recorded, just empty");

  const corrupt = "not json at all\n{\"event\":\"step\",\"kind\":\"tool\",\"label\":\"ok\",\"status\":\"done\"}\n{ broken\n";
  const { steps } = deriveSteps(corrupt);
  assert.equal(steps.length, 1, "corrupt lines skipped, never thrown, only the real event survives");
  assert.equal(steps[0].label, "ok");
});

test("honesty: absent log -> steps_recorded:false via readSteps (file wrapper)", () => {
  const ctx = mkRun();
  const missingRunDir = join(ctx.home, ".sdlc", "does-not-exist");
  const r = readSteps(missingRunDir);
  assert.deepEqual(r.steps, []);
  assert.equal(r.steps_recorded, false);
  assert.equal(r.answer.recorded, false);
});

test("honesty: rendered HTML says 'no steps recorded' when absent/empty, never an empty-but-checked-off list", () => {
  const htmlAbsent = renderLiveHtml({
    run_id: "r1", stage: "intake", stage_status: "pending", complete: false,
    steps: [], steps_recorded: false, answer: { recorded: false, text: "" },
  });
  assert.match(htmlAbsent, /no steps recorded/);

  const htmlEmpty = renderLiveHtml({
    run_id: "r1", stage: "intake", stage_status: "pending", complete: false,
    steps: [], steps_recorded: true, answer: { recorded: false, text: "" },
  });
  assert.match(htmlEmpty, /no steps recorded/);
});

test("honesty: no answer chunks -> answer pane omitted entirely from the HTML", () => {
  const html = renderLiveHtml({
    run_id: "r1", stage: "intake", stage_status: "pending", complete: false,
    steps: [{ kind: "tool", label: "x", status: "doing" }], steps_recorded: true,
    answer: { recorded: false, text: "" },
  });
  assert.ok(!/<h2>answer<\/h2>/.test(html), "no answer pane when nothing was recorded");
});

// ---------------------------------------------------------------------------
// Answer streams
// ---------------------------------------------------------------------------

test("answer streams: kind:answer chunks concatenate in event order and are absent from the checklist", () => {
  const text =
    ev({ event: "step", kind: "tool", label: "grep repo", status: "done" }) +
    ev({ event: "step", kind: "answer", label: "The fix is " }) +
    ev({ event: "step", kind: "answer", label: "to bump the timeout." });
  const { steps, answer } = deriveSteps(text);
  assert.equal(steps.length, 1, "answer chunks are not checklist items");
  assert.equal(steps[0].label, "grep repo");
  assert.equal(answer.recorded, true);
  assert.equal(answer.text, "The fix is to bump the timeout.");

  const html = renderLiveHtml({
    run_id: "r1", stage: null, stage_status: "done", complete: true,
    steps, steps_recorded: true, answer,
  });
  assert.match(html, /The fix is to bump the timeout\./);
});

// ---------------------------------------------------------------------------
// Refresh honesty
// ---------------------------------------------------------------------------

test("refresh honesty: meta-refresh present iff the run is not complete", () => {
  const live = renderLiveHtml({
    run_id: "r1", stage: "implement", stage_status: "in_progress", complete: false,
    steps: [], steps_recorded: false, answer: { recorded: false, text: "" },
  });
  assert.match(live, /<meta http-equiv="refresh"/);
  assert.match(live, /auto-refreshes/);

  const done = renderLiveHtml({
    run_id: "r1", stage: null, stage_status: "done", complete: true,
    steps: [], steps_recorded: false, answer: { recorded: false, text: "" },
  });
  assert.ok(!/<meta http-equiv="refresh"/.test(done), "no refresh tag once complete");
  assert.match(done, /run complete/);
});

// ---------------------------------------------------------------------------
// isRunComplete
// ---------------------------------------------------------------------------

test("isRunComplete: true only when every stage is done or skipped", () => {
  assert.equal(isRunComplete({ stages: { a: { status: "pending" }, b: { status: "done" } } }), false);
  assert.equal(isRunComplete({ stages: { a: { status: "done" }, b: { status: "skipped" } } }), true);
  assert.equal(isRunComplete({ stages: {} }), false);
  assert.equal(isRunComplete(null), false);
});

// ---------------------------------------------------------------------------
// Stage cell honesty (unreadable status must not read as "complete")
// ---------------------------------------------------------------------------

test("stage cell: shows 'unknown' (not 'complete') when stage is null and the run is NOT complete (unreadable status)", () => {
  const html = renderLiveHtml({
    run_id: "r1", stage: null, stage_status: "unreadable (stage-status.json missing)", complete: false,
    steps: [], steps_recorded: false, answer: { recorded: false, text: "" },
  });
  assert.match(html, /<th>stage<\/th><td>unknown<\/td>/, "stage cell says 'unknown', not the contradictory 'complete'");
  assert.ok(!/<th>stage<\/th><td>complete<\/td>/.test(html), "never 'complete' next to an unreadable status");
});

test("stage cell: still shows 'complete' when stage is null AND the run genuinely completed", () => {
  const html = renderLiveHtml({
    run_id: "r1", stage: null, stage_status: "done", complete: true,
    steps: [], steps_recorded: true, answer: { recorded: false, text: "" },
  });
  assert.match(html, /<th>stage<\/th><td>complete<\/td>/);
});

// ---------------------------------------------------------------------------
// Timeout honesty (renderLiveHtml timedOut flag)
// ---------------------------------------------------------------------------

test("timedOut: drops the refresh tag and shows an honest 'watch ended (timeout)' footer even though the run is incomplete", () => {
  const html = renderLiveHtml({
    run_id: "r1", stage: "implement", stage_status: "in_progress", complete: false,
    steps: [], steps_recorded: false, answer: { recorded: false, text: "" },
    timedOut: true, timedOutAt: "2026-07-14T00:05:00Z",
  });
  assert.ok(!/<meta http-equiv="refresh"/.test(html), "no refresh tag once the watcher has given up");
  assert.match(html, /watch ended \(timeout\)/);
  assert.match(html, /run still in progress as of 2026-07-14T00:05:00Z/);
  assert.ok(!/run complete/.test(html), "never claims completion — the run is still incomplete");
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

test("CLI: run new -> step doing -> live (artifact shows doing) -> step done -> live (flipped, one item)", () => {
  const ctx = mkRun();
  let r = engine(["step", "x", "--run", ctx.runId, "--repo", ctx.repo, "--status", "doing"]);
  assert.equal(r.code, 0, r.stdout);

  r = engine(["live", ctx.runId, "--repo", ctx.repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(existsSync(r.json.artifact), "artifact written");
  let html = readFileSync(r.json.artifact, "utf8");
  assert.match(html, /&#9655; x /, "doing glyph present");
  assert.equal((html.match(/<li>/g) || []).length, 1, "one checklist item");

  r = engine(["step", "x", "--run", ctx.runId, "--repo", ctx.repo, "--status", "done"]);
  assert.equal(r.code, 0, r.stdout);

  r = engine(["live", ctx.runId, "--repo", ctx.repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  html = readFileSync(r.json.artifact, "utf8");
  assert.match(html, /&#9745; x /, "flipped to done glyph");
  assert.equal((html.match(/<li>/g) || []).length, 1, "still one item, not a duplicate row");
});

test("CLI: engine live with no id refuses, exit 2", () => {
  mkRun(); // establishes a fresh DETENT_ROOT home
  const r = engine(["live"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
});

test("CLI: engine live refuses an unknown run id, exit 2", () => {
  const ctx = mkRun();
  const r = engine(["live", "no-such-run", "--repo", ctx.repo]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
});

test("CLI: engine live refuses a non-numeric --interval-ms, exit 2 (NaN never reaches setInterval)", () => {
  const ctx = mkRun();
  const r = engine(["live", ctx.runId, "--repo", ctx.repo, "--watch", "--interval-ms", "abc"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /interval-ms/);
});

test("CLI: engine live refuses a zero/negative --interval-ms, exit 2", () => {
  const ctx = mkRun();
  let r = engine(["live", ctx.runId, "--repo", ctx.repo, "--watch", "--interval-ms", "0"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  r = engine(["live", ctx.runId, "--repo", ctx.repo, "--watch", "--interval-ms", "-5"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
});

test("CLI: engine live refuses a non-numeric/non-positive --timeout-s, exit 2 (never silently becomes no-timeout)", () => {
  const ctx = mkRun();
  let r = engine(["live", ctx.runId, "--repo", ctx.repo, "--watch", "--timeout-s", "abc"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /timeout-s/);

  r = engine(["live", ctx.runId, "--repo", ctx.repo, "--watch", "--timeout-s", "0"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
});

test("CLI: engine live (one-shot) shows 'unknown' stage when stage-status.json is missing/unreadable", () => {
  const ctx = mkRun();
  const statusPath = join(ctx.runDir, "stage-status.json");
  // Force the "unreadable" branch cmdLive's render() takes.
  rmSync(statusPath, { force: true });

  const r = engine(["live", ctx.runId, "--repo", ctx.repo]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.complete, false);
  assert.equal(r.json.stage, null);
  const html = readFileSync(r.json.artifact, "utf8");
  assert.match(html, /<th>stage<\/th><td>unknown<\/td>/, "never shows the contradictory 'complete' next to an unreadable status");
});

// ---------------------------------------------------------------------------
// Watch (streaming end-to-end, offline)
// ---------------------------------------------------------------------------

test("CLI: --watch streams appended events into the artifact and exits 0 on completion, no meta-refresh at the end", async () => {
  const ctx = mkRun();
  const home = detentHome();

  const child = spawn(process.execPath,
    [ENGINE, "live", ctx.runId, "--repo", ctx.repo, "--watch", "--interval-ms", "50", "--timeout-s", "10"],
    { encoding: "utf8", env: { ...process.env, DETENT_ROOT: home } });

  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  let exited = null;
  child.on("exit", (code) => { exited = code; });

  // Wait for the watcher's start line.
  const waitFor = async (cond, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  assert.ok(await waitFor(() => stdout.includes("\n") || stdout.trim().length > 0, 3000), "watcher printed its start line");

  const artifact = join(home, ".plans", `engine-live-${ctx.runId}.html`);
  assert.ok(await waitFor(() => existsSync(artifact), 3000), "artifact written by the watcher");

  // Append a done event via `engine step` and poll the artifact for the flip.
  const stepR = engine(["step", "second thing", "--run", ctx.runId, "--repo", ctx.repo, "--status", "done"]);
  assert.equal(stepR.code, 0, stepR.stdout);

  assert.ok(await waitFor(() => {
    if (!existsSync(artifact)) return false;
    const html = readFileSync(artifact, "utf8");
    return /&#9745; second thing/.test(html);
  }, 5000), "artifact reflects the appended done event while the watcher is live");

  // Complete the run without an accompanying event (direct file edit) — the
  // watcher must still notice via stage-status.json polling and exit.
  const statusPath = join(ctx.runDir, "stage-status.json");
  const status = readJson(statusPath);
  for (const s of Object.keys(status.stages)) status.stages[s] = { status: "done" };
  writeJson(statusPath, status);

  assert.ok(await waitFor(() => exited !== null, 8000), "watcher process exited");
  assert.equal(exited, 0, "watcher exits 0 on completion");

  const finalHtml = readFileSync(artifact, "utf8");
  assert.ok(!/<meta http-equiv="refresh"/.test(finalHtml), "final artifact has no meta-refresh (stable for annotation)");
  assert.match(finalHtml, /run complete/);
});

test("CLI: --watch on a run that NEVER completes exits 3 (not 0) when --timeout-s elapses, dropping the refresh tag with an honest footer", async () => {
  const ctx = mkRun(); // left incomplete — no stage ever driven to done/skipped
  const home = detentHome();

  const child = spawn(process.execPath,
    [ENGINE, "live", ctx.runId, "--repo", ctx.repo, "--watch", "--interval-ms", "30", "--timeout-s", "0.3"],
    { encoding: "utf8", env: { ...process.env, DETENT_ROOT: home } });

  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  let exited = null;
  child.on("exit", (code) => { exited = code; });

  const waitFor = async (cond, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  assert.ok(await waitFor(() => exited !== null, 5000), "watcher process exited after its timeout elapsed");
  assert.equal(exited, 3, "timeout on an incomplete run exits 3, distinct from real completion (0)");

  const startLine = JSON.parse(stdout.trim().split("\n")[0]);
  assert.equal(startLine.ok, true);

  const artifact = join(home, ".plans", `engine-live-${ctx.runId}.html`);
  const finalHtml = readFileSync(artifact, "utf8");
  assert.ok(!/<meta http-equiv="refresh"/.test(finalHtml), "refresh tag dropped once the watcher has given up, run or not");
  assert.match(finalHtml, /watch ended \(timeout\)/, "honest footer, never left saying 'live' forever");
  assert.match(finalHtml, /run still in progress/);
  assert.ok(!/run complete/.test(finalHtml), "must never claim completion — the run genuinely never finished");
});
