import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engine, mkCuratorClone, mkRun, writeArtifact, readJson, writeJson, throughResearch } from "./helpers.mjs";
import { setup, drive } from "./drive-kit.mjs";

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

function collect(ctx, items) {
  const f = join(mkdtempSync(join(tmpdir(), "answered-fb-")), "feedback.json");
  writeJson(f, items);
  return engine(["gate", "collect", "--run", ctx.runId, "--file", f], { env: { PATH: BARE_PATH } });
}

const decisionOf = (ctx, id) => readJson(join(ctx.runDir, "decisions.json")).find((x) => x.id === id);

test("the same answer sent again for an answered decision is recorded and changes nothing", () => {
  const { ctx, gate } = atPlanGate();
  assert.equal(collect(ctx, [{ type: "decision", question: gate.id, answer: "approve" }]).json.answered[0], gate.id);
  const before = decisionOf(ctx, gate.id);
  const r = collect(ctx, [{ type: "decision", question: gate.id, answer: " Approve " }]);
  assert.equal(r.json.unresolved.length, 1);
  assert.equal(r.json.unresolved[0].recorded, true);
  const after = decisionOf(ctx, gate.id);
  assert.equal(after.answer, "approve");
  assert.equal(after.answered_at, before.answered_at);
  assert.equal(after.rejected_answer, undefined);
});

test("a different answer for an answered decision is unrecorded and does not set rejected_answer", () => {
  const { ctx, gate } = atPlanGate();
  collect(ctx, [{ type: "decision", question: gate.id, answer: "approve" }]);
  const r = collect(ctx, [{ type: "decision", question: gate.id, answer: "revise" }]);
  assert.equal(r.json.unresolved[0].recorded, undefined);
  assert.equal(decisionOf(ctx, gate.id).rejected_answer, undefined);
});

/** A clone whose curator stub prints STUB_DRAIN on `drain`. */
function stubDrain(t) {
  t.curatorDir = mkdtempSync(join(tmpdir(), "answered-drain-"));
  mkCuratorClone(t.curatorDir, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "open") console.log(JSON.stringify({ url: "http://127.0.0.1:9/s/stub", key: a[1] }));
if (a[0] === "drain" && process.env.STUB_DRAIN) console.log(process.env.STUB_DRAIN);
`);
}

/** A run with the intent gate pending and a second, already answered decision. */
function withAnsweredDecision() {
  const t = setup();
  stubDrain(t);
  const first = drive(t, {});
  assert.equal(first.json.stopped, "needs_human", first.stdout + first.stderr);
  const p = join(t.runDir, "decisions.json");
  const ds = readJson(p);
  const intent = ds.find((d) => d.gate === "intent");
  const done = { ...intent, id: "D-900", gate: intent.gate, status: "answered", answer: "approve",
    answered_by: "human", answered_at: new Date().toISOString() };
  writeJson(p, [...ds, done]);
  return { t, first, intent };
}

const drainFor = (first, answer) => JSON.stringify({ key: realpathSync(first.json.html), status: "feedback",
  prompts: [{ type: "decision", question: "D-900", answer }] });

test("drive does not stop when the answer for an answered decision is resent", () => {
  const { t, first } = withAnsweredDecision();
  const r = drive(t, {}, [], { STUB_DRAIN: drainFor(first, "approve") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.stopped, "needs_human");
});

test("drive stops with the id, old answer, new answer and the missing re-open command when the answer differs", () => {
  const { t, first } = withAnsweredDecision();
  const r = drive(t, {}, [], { STUB_DRAIN: drainFor(first, "revise") });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.reason, "curator_feedback_unresolved");
  const detail = JSON.stringify(readJson(join(t.runDir, "drive-last.json")).detail);
  assert.match(detail, /D-900/);
  assert.match(detail, /approve/);
  assert.match(detail, /revise/);
  assert.match(detail, /no engine command re-opens/);
});

test("an invalid option with a note keeps the note and stays unrecorded", () => {
  const { ctx, gate } = atPlanGate();
  const r = collect(ctx, [{ type: "decision", question: gate.id, answer: "maybe", note: "not sure about step 2" }]);
  assert.equal(r.json.unresolved.length, 1);
  assert.equal(r.json.unresolved[0].recorded, undefined);
  const d = decisionOf(ctx, gate.id);
  assert.equal(d.status, "pending");
  assert.deepEqual(d.human_notes.map((n) => n.note), ["not sure about step 2"]);
});

test("an empty item is not recorded", () => {
  const { ctx, gate } = atPlanGate();
  const r = collect(ctx, [{ type: "decision", question: gate.id }]);
  assert.equal(r.json.unresolved.length, 1);
  assert.equal(r.json.unresolved[0].recorded, undefined);
  assert.equal(decisionOf(ctx, gate.id).human_notes, undefined);
});

test("a note-only reply shows once on the re-rendered page", () => {
  const g = atPlanGate();
  // What curator's drain stamps for a note-only reply: no data-curator-answered, just the time and the note.
  const q = `<div data-plan-question="${g.gate.id}"`;
  const stamped = readFileSync(g.html, "utf8").replace(q, `${q} data-curator-answered-at="2026-11-09T00:00:00.000Z" data-curator-answered-note="need the rollback plan"`);
  writeFileSync(g.html, stamped);
  collect(g.ctx, [{ type: "decision", question: g.gate.id, answer: null, note: "need the rollback plan" }]);
  g.open();
  const html = readFileSync(g.html, "utf8");
  assert.equal(html.split("need the rollback plan").length - 1, 1);
});

test("a note-only reply containing an apostrophe shows once on the re-rendered page", () => {
  const g = atPlanGate();
  const q = `<div data-plan-question="${g.gate.id}"`;
  writeFileSync(g.html, readFileSync(g.html, "utf8").replace(q, `${q} data-curator-answered-at="2026-11-09T00:00:00.000Z" data-curator-answered-note="don't ship &lt;yet&gt; &amp; &quot;wait&quot;"`));
  collect(g.ctx, [{ type: "decision", question: g.gate.id, answer: null, note: `don't ship <yet> & "wait"` }]);
  g.open();
  const html = readFileSync(g.html, "utf8");
  assert.equal(html.split("ship").length - 1, 1);
});

test("a refused proceed-degraded answer with a note shows the note once after re-render", () => {
  const g = atPlanGate();
  const p = join(g.ctx.runDir, "decisions.json");
  const DEGRADED = "proceed degraded (accept degraded confidence)";
  writeJson(p, readJson(p).map((d) => (d.id === g.gate.id ? { ...d, cause: "judgment", options: [...d.options, DEGRADED] } : d)));
  g.open();
  const q = `<div data-plan-question="${g.gate.id}"`;
  writeFileSync(g.html, readFileSync(g.html, "utf8").replace(q, `${q} data-curator-answered="${DEGRADED}" data-curator-answered-at="2026-11-09T00:00:00.000Z" data-curator-answered-note="need sign-off first"`));
  collect(g.ctx, [{ type: "decision", question: g.gate.id, answer: DEGRADED, note: "need sign-off first" }]);
  g.open();
  assert.equal(readFileSync(g.html, "utf8").split("need sign-off first").length - 1, 1);
});

test("a changed answer for an answered decision gets a headline that does not ask for an impossible answer", () => {
  const { t, first } = withAnsweredDecision();
  const r = drive(t, {}, [], { STUB_DRAIN: drainFor(first, "revise") });
  assert.equal(r.json.reason, "curator_feedback_unresolved");
  assert.doesNotMatch(r.json.next_step, /answer the gate with an exact option/);
  assert.match(r.json.next_step, /drive-last\.json/);
});
