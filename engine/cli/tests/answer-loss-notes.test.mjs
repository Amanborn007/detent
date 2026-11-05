import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDecisions } from "../drive/outbox.mjs";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, throughResearch } from "./helpers.mjs";
import { setup, drive } from "./drive-kit.mjs";

const CURATOR_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "curator", "cli.mjs");
const BARE_PATH = "/usr/bin:/bin";
const STAGES = ["intake", "research", "plan", "implement", "recheck", "ship", "respond"];

function atPlanGate() {
  const ctx = mkRun();
  throughResearch(ctx);
  assert.equal(engine(["stage", "begin", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 0);
  writeArtifact(ctx.runDir, "plan/plan.md", "# plan\n");
  assert.equal(engine(["stage", "end", "plan", "--repo", ctx.repo, "--run", ctx.runId]).code, 2);
  const r = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: BARE_PATH } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const gate = readJson(join(ctx.runDir, "decisions.json")).find((d) => d.gate === "intent");
  return { ctx, gate, html: r.json.html };
}

function collect(ctx, items) {
  const f = join(mkdtempSync(join(tmpdir(), "notes-")), "feedback.json");
  writeJson(f, items);
  return engine(["gate", "collect", "--run", ctx.runId, "--file", f], { env: { PATH: BARE_PATH } });
}

test("a note-only answer is recorded on the decision as human_notes and shown on the gate page", () => {
  const { ctx, gate } = atPlanGate();
  const r = collect(ctx, [{ type: "decision", question: gate.id, answer: null, note: "need the rollback plan" }]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.unresolved.length, 1);
  const d = readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === gate.id);
  assert.equal(d.status, "pending");
  assert.equal(d.human_notes.length, 1);
  assert.equal(d.human_notes[0].note, "need the rollback plan");
  assert.equal(d.human_notes[0].answer_if_any, null);
  assert.ok(d.human_notes[0].at);
  const again = engine(["gate", "open", "intent", "--repo", ctx.repo, "--run", ctx.runId], { env: { PATH: BARE_PATH } });
  assert.match(readFileSync(again.json.html, "utf8"), /need the rollback plan/);
});

test("a re-answer of an already answered decision keeps its note in human_notes", () => {
  const { ctx, gate } = atPlanGate();
  assert.equal(collect(ctx, [{ type: "decision", question: gate.id, answer: "approve" }]).json.answered[0], gate.id);
  const r = collect(ctx, [{ type: "decision", question: gate.id, answer: "revise", note: "changed my mind" }]);
  assert.equal(r.json.unresolved.length, 1);
  const d = readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === gate.id);
  assert.equal(d.answer, "approve");
  assert.deepEqual(d.human_notes.map((n) => [n.note, n.answer_if_any]), [["changed my mind", "revise"]]);
});

test("the outbox refuses a child-written human_notes", () => {
  const r = validateDecisions([{ key: "u1", question: "Which?", options: ["a", "b"], blocks: ["implement"], cause: "judgment", human_notes: [] }],
    { stage: "plan", stages: STAGES });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "forbidden_key");
});

/** A clone whose curator stub prints STUB_DRAIN on `drain` (and nothing when unset) or fails when STUB_FAIL is set. */
function stubDrain(t) {
  t.curatorDir = mkdtempSync(join(tmpdir(), "drive-drain-"));
  mkCuratorClone(t.curatorDir, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "open") console.log(JSON.stringify({ url: "http://127.0.0.1:9/s/stub", key: a[1] }));
if (a[0] === "drain") {
  if (process.env.STUB_FAIL) { console.error("drain exploded"); process.exit(3); }
  if (process.env.STUB_DRAIN) console.log(process.env.STUB_DRAIN);
}
`);
}

test("a recorded note-only reply takes drive to the normal needs_human stop, showing the note", () => {
  const t = setup();
  stubDrain(t);
  const first = drive(t, {});
  assert.equal(first.json.stopped, "needs_human", first.stdout + first.stderr);
  const gate = readJson(join(t.runDir, "decisions.json")).find((d) => d.gate === "intent");
  const drainLine = JSON.stringify({ key: realpathSync(first.json.html), status: "feedback",
    prompts: [{ type: "decision", question: gate.id, answer: null, note: "hold on, check X" }] });
  const r = drive(t, {}, [], { STUB_DRAIN: drainLine });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
  const d = readJson(join(t.runDir, "decisions.json")).find((x) => x.id === gate.id);
  assert.equal(d.status, "pending");
  assert.equal(d.human_notes[0].note, "hold on, check X");
  assert.match(readFileSync(r.json.html, "utf8"), /hold on, check X/);
});

test("drive still fails loudly on feedback naming an unknown decision", () => {
  const t = setup();
  stubDrain(t);
  const first = drive(t, {});
  const drainLine = JSON.stringify({ key: realpathSync(first.json.html), status: "feedback",
    prompts: [{ type: "decision", question: "D-999", answer: "approve" }] });
  const r = drive(t, {}, [], { STUB_DRAIN: drainLine });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "curator_feedback_unresolved");
});

test("drive stops loudly when collecting curator feedback fails", () => {
  const t = setup();
  stubDrain(t);
  assert.equal(drive(t, {}).json.stopped, "needs_human");
  const r = drive(t, {}, [], { STUB_FAIL: "1" });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "curator_collect_failed");
  assert.match(r.stderr + r.stdout, /drain exploded/);
});

test("a missing curator state dir is not a collect error", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-state-"));
  const r = spawnSync(process.execPath, [CURATOR_CLI, "drain"], {
    encoding: "utf8", env: { ...process.env, CURATOR_STATE_DIR: join(dir, "missing"), CURATOR_NO_BROWSER: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).status, "idle");
});
